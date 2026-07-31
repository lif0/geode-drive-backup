import { requestUrl } from 'obsidian';

import type { Result } from '../types';
import { authError, err, networkError, ok } from '../types';
import { describeErrorBody, isTokenResponseDto, parseJson } from './dto';

/**
 * OAuth plumbing shared by both flows.
 *
 * Only the refresh token is ever written to disk. Access tokens live in memory
 * with an expiry and are re-derived on demand, so a stolen data.json still
 * cannot be used without the user's own OAuth client secret.
 */

/**
 * The one scope Geode asks for: files this app created, nothing else.
 *
 * Never widen this to `auth/drive`. Full Drive is a restricted scope and needs a
 * paid third-party security assessment, and it would give a backup plugin read
 * access to everything the user owns.
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Google's OAuth token endpoint. */
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Refresh this many milliseconds before the token actually expires. */
const EXPIRY_SKEW_MS = 60_000;

/** The user's own OAuth client, pasted into settings. */
export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Where the refresh token is read from and written to. */
export interface RefreshTokenStore {
  read(): string | null;
  write(token: string | null): Promise<void>;
}

/** An access token and the moment it stops working. */
export interface AccessToken {
  readonly value: string;
  readonly expiresAt: number;
}

/**
 * What push, pull and the settings tab see. The device and PKCE flows are
 * interchangeable behind it.
 */
export interface AuthProvider {
  /** True if a refresh token is stored. Does not prove Google still honours it. */
  isConnected(): boolean;
  /** Runs the interactive sign-in and stores the resulting refresh token. */
  connect(): Promise<Result<void>>;
  /** A valid access token, refreshed if needed. */
  getAccessToken(): Promise<Result<string>>;
  /** Drops the cached access token so the next call refreshes. Used on a 401. */
  invalidate(): void;
  /** Forgets the refresh token. The Google-side grant is not revoked. */
  disconnect(): Promise<void>;
}

/** A completed HTTP exchange, success or not. */
export interface HttpOutcome {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

/**
 * POSTs a form-encoded body through Obsidian's `requestUrl`.
 *
 * `fetch` is not an option: Obsidian's renderer enforces CORS, and Google's
 * token endpoint sends no permissive headers. Non-2xx statuses come back as a
 * value, because the device flow's normal polling states are HTTP errors.
 */
export async function postForm(
  url: string,
  fields: Record<string, string>,
): Promise<Result<HttpOutcome>> {
  const body = Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

  try {
    const response = await requestUrl({
      url,
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body,
      throw: false,
    });
    return ok({ status: response.status, body: parseJson(response.text), text: response.text });
  } catch (cause) {
    return err(networkError('Could not reach Google. Check your connection.', cause));
  }
}

/**
 * Trades a refresh token for an access token.
 *
 * Does NOT retry: the caller decides whether a failure is worth another attempt.
 */
export async function refreshAccessToken(
  client: OAuthClient,
  refreshToken: string,
): Promise<Result<AccessToken>> {
  const outcome = await postForm(TOKEN_ENDPOINT, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (!outcome.ok) return outcome;

  if (outcome.value.status < 200 || outcome.value.status >= 300) {
    const reason = describeErrorBody(outcome.value.body, outcome.value.text);
    return err(authError(`Google refused the stored credentials: ${reason}`));
  }

  if (!isTokenResponseDto(outcome.value.body)) {
    return err(authError('Google returned a token response Geode could not read.'));
  }

  return ok({
    value: outcome.value.body.access_token,
    expiresAt: Date.now() + outcome.value.body.expires_in * 1000,
  });
}

/** True if the body says the grant is dead and reconnecting is the only fix. */
function isDeadGrant(body: unknown, text: string): boolean {
  return describeErrorBody(body, text).includes('invalid_grant');
}

/**
 * Token caching and refresh, shared by both flows. Subclasses supply `connect`.
 */
export abstract class CachingAuthProvider implements AuthProvider {
  private cached: AccessToken | null = null;

  constructor(
    protected readonly readClient: () => OAuthClient,
    protected readonly tokens: RefreshTokenStore,
  ) {}

  abstract connect(): Promise<Result<void>>;

  isConnected(): boolean {
    return this.tokens.read() !== null;
  }

  invalidate(): void {
    this.cached = null;
  }

  async disconnect(): Promise<void> {
    this.cached = null;
    await this.tokens.write(null);
  }

  async getAccessToken(): Promise<Result<string>> {
    const cached = this.cached;
    if (cached !== null && cached.expiresAt > Date.now() + EXPIRY_SKEW_MS) {
      return ok(cached.value);
    }

    const refreshToken = this.tokens.read();
    if (refreshToken === null) {
      return err(authError('Not connected to Google Drive. Run "Connect Google account" first.'));
    }

    const client = this.readClient();
    if (client.clientId.length === 0 || client.clientSecret.length === 0) {
      return err(authError('Missing OAuth client id or secret. Add them in Geode settings.'));
    }

    const refreshed = await refreshAccessToken(client, refreshToken);
    if (!refreshed.ok) {
      // A revoked or expired grant will never work again. Clearing it stops
      // every later operation from failing the same slow way.
      if (refreshed.error.message.includes('invalid_grant')) {
        await this.tokens.write(null);
        return err(
          authError('Google revoked this connection. Run "Connect Google account" again.'),
        );
      }
      return refreshed;
    }

    this.cached = refreshed.value;
    return ok(refreshed.value.value);
  }

  /** Stores a fresh grant after an interactive sign-in. */
  protected async acceptGrant(token: {
    refreshToken: string | undefined;
    accessToken: string;
    expiresIn: number;
  }): Promise<Result<void>> {
    if (token.refreshToken === undefined || token.refreshToken.length === 0) {
      return err(
        authError(
          'Google did not return a refresh token. Remove Geode at ' +
            'myaccount.google.com/permissions and connect again.',
        ),
      );
    }

    await this.tokens.write(token.refreshToken);
    this.cached = {
      value: token.accessToken,
      expiresAt: Date.now() + token.expiresIn * 1000,
    };
    return ok(undefined);
  }
}

/** Shared by both flows: turns a token-endpoint reply into a stored grant. */
export function readGrantResponse(outcome: HttpOutcome): Result<{
  refreshToken: string | undefined;
  accessToken: string;
  expiresIn: number;
}> {
  if (outcome.status < 200 || outcome.status >= 300) {
    const reason = describeErrorBody(outcome.body, outcome.text);
    if (isDeadGrant(outcome.body, outcome.text)) {
      return err(authError(`Google rejected the sign-in: ${reason}`));
    }
    return err(authError(`Sign-in failed: ${reason}`));
  }

  if (!isTokenResponseDto(outcome.body)) {
    return err(authError('Google returned a sign-in response Geode could not read.'));
  }

  return ok({
    refreshToken: outcome.body.refresh_token,
    accessToken: outcome.body.access_token,
    expiresIn: outcome.body.expires_in,
  });
}
