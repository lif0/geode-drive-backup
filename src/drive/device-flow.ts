import type { Result } from '../types';
import { authError, cancelledError, err, ok } from '../types';
import type { OAuthClient, RefreshTokenStore } from './auth-provider';
import {
  CachingAuthProvider,
  DRIVE_SCOPE,
  TOKEN_ENDPOINT,
  postForm,
  readGrantResponse,
} from './auth-provider';
import type { DeviceCodeDto } from './dto';
import { describeErrorBody, isDeviceCodeDto, isOAuthErrorDto, readVerificationUrl } from './dto';

/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * The default flow because it needs no redirect URI and no local web server,
 * which is what makes it work on a phone: Geode shows a code, the user types it
 * into google.com/device on any device, and Geode polls until they finish.
 */

/** Where a device code is requested. */
export const DEVICE_CODE_ENDPOINT = 'https://oauth2.googleapis.com/device/code';

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** Used when Google omits `interval`, per RFC 8628. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/** Added to the interval each time Google answers `slow_down`. */
const SLOW_DOWN_STEP_SECONDS = 5;

/** What the user has to be shown to authorise the app. */
export interface DeviceCodePrompt {
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresInSeconds: number;
}

/** How the flow talks to the UI. Injected so this file has no Modal in it. */
export interface DeviceFlowUi {
  /** Shows the code. Resolves when the user cancels, rejects nothing. */
  present(prompt: DeviceCodePrompt): void;
  /** True once the user has dismissed the dialog. Polling stops. */
  isCancelled(): boolean;
  /** Closes the dialog, whatever the outcome. */
  dismiss(): void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Signs in with the device flow.
 *
 * Requires an OAuth client of type "TVs and Limited Input devices". A Desktop or
 * Web client makes Google reject the device-code request outright, which is when
 * the PKCE fallback earns its keep.
 */
export class DeviceFlowAuthProvider extends CachingAuthProvider {
  constructor(
    readClient: () => OAuthClient,
    tokens: RefreshTokenStore,
    private readonly ui: DeviceFlowUi,
  ) {
    super(readClient, tokens);
  }

  override async connect(): Promise<Result<void>> {
    const client = this.readClient();
    if (client.clientId.length === 0) {
      return err(authError('Add your OAuth client id in Geode settings first.'));
    }

    const started = await this.requestDeviceCode(client);
    if (!started.ok) return started;

    this.ui.present({
      userCode: started.value.user_code,
      verificationUrl: readVerificationUrl(started.value),
      expiresInSeconds: started.value.expires_in,
    });

    try {
      const granted = await this.poll(
        client,
        started.value.device_code,
        started.value.interval ?? DEFAULT_POLL_INTERVAL_SECONDS,
        started.value.expires_in,
      );
      if (!granted.ok) return granted;
      return await this.acceptGrant(granted.value);
    } finally {
      this.ui.dismiss();
    }
  }

  private async requestDeviceCode(client: OAuthClient): Promise<Result<DeviceCodeDto>> {
    const outcome = await postForm(DEVICE_CODE_ENDPOINT, {
      client_id: client.clientId,
      scope: DRIVE_SCOPE,
    });
    if (!outcome.ok) return outcome;

    if (outcome.value.status < 200 || outcome.value.status >= 300) {
      const reason = describeErrorBody(outcome.value.body, outcome.value.text);
      return err(
        authError(
          `Google refused the device flow: ${reason}. ` +
            'Check the client is of type "TVs and Limited Input devices", ' +
            'or switch to the PKCE fallback in settings.',
        ),
      );
    }

    if (!isDeviceCodeDto(outcome.value.body)) {
      return err(authError('Google returned a device code Geode could not read.'));
    }
    return ok(outcome.value.body);
  }

  /**
   * Polls the token endpoint until the user approves, cancels or the code dies.
   *
   * The three states that are not failures: `authorization_pending` means keep
   * waiting, `slow_down` means the same but less often, and a cancelled dialog
   * means stop. Everything else aborts.
   */
  private async poll(
    client: OAuthClient,
    deviceCode: string,
    initialInterval: number,
    expiresInSeconds: number,
  ): Promise<Result<{ refreshToken: string | undefined; accessToken: string; expiresIn: number }>> {
    let intervalSeconds = Math.max(initialInterval, 1);
    const deadline = Date.now() + expiresInSeconds * 1000;

    while (Date.now() < deadline) {
      if (this.ui.isCancelled()) {
        return err(cancelledError('Sign-in cancelled.'));
      }

      await sleep(intervalSeconds * 1000);

      if (this.ui.isCancelled()) {
        return err(cancelledError('Sign-in cancelled.'));
      }

      const outcome = await postForm(TOKEN_ENDPOINT, {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT_TYPE,
      });
      if (!outcome.ok) return outcome;

      if (outcome.value.status >= 200 && outcome.value.status < 300) {
        return readGrantResponse(outcome.value);
      }

      const body = outcome.value.body;
      const code = isOAuthErrorDto(body) ? body.error : '';

      switch (code) {
        case 'authorization_pending':
          continue;
        case 'slow_down':
          intervalSeconds += SLOW_DOWN_STEP_SECONDS;
          continue;
        case 'expired_token':
          return err(authError('The sign-in code expired. Start "Connect Google account" again.'));
        case 'access_denied':
          return err(cancelledError('Sign-in was denied in the browser.'));
        default:
          return err(authError(`Sign-in failed: ${describeErrorBody(body, outcome.value.text)}`));
      }
    }

    return err(authError('The sign-in code expired. Start "Connect Google account" again.'));
  }
}
