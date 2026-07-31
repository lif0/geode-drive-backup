import { toBase64Url, utf8Encode } from '../core/bytes';
import type { CryptoProvider, Result } from '../types';
import { authError, cancelledError, err } from '../types';
import type { OAuthClient, RefreshTokenStore } from './auth-provider';
import { CachingAuthProvider, DRIVE_SCOPE, TOKEN_ENDPOINT, postForm, readGrantResponse } from './auth-provider';

/**
 * Installed-app redirect flow with PKCE. The fallback when Google refuses the
 * device flow for this client type.
 *
 * Google retired the out-of-band redirect in 2022, so the redirect goes to a
 * loopback URL that nothing is listening on. The browser shows a connection
 * error and the authorization code sits in the address bar; the user copies it
 * back. Ugly, but it needs no local server, which is the only thing that works
 * on a phone.
 */

/** Google's authorization endpoint. */
export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/**
 * The redirect target. Nothing listens here — the URL exists only so the code
 * lands somewhere the user can read it.
 */
export const REDIRECT_URI = 'http://127.0.0.1:42813/geode';

/** How the flow talks to the UI. */
export interface PkceFlowUi {
  /**
   * Shows `authUrl` and waits for the user to paste the result back.
   * Resolves to the pasted text, or null if they cancelled.
   */
  requestCode(authUrl: string): Promise<string | null>;
}

/** 96 random bytes as base64url: 128 characters, the RFC 7636 maximum. */
function createVerifier(crypto: CryptoProvider): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(96)));
}

async function challengeFor(crypto: CryptoProvider, verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8Encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

/**
 * Pulls the authorization code out of whatever the user pasted.
 *
 * Accepts the bare code or the whole redirected URL, because "copy the address
 * bar" is the instruction that actually survives contact with users. Returns
 * null if there is no code in there.
 */
export function extractAuthCode(pasted: string): string | null {
  const trimmed = pasted.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.includes('code=')) {
    const match = /[?&#]code=([^&\s]+)/.exec(trimmed);
    const captured = match?.[1];
    if (captured === undefined) return null;
    return decodeURIComponent(captured);
  }

  // A bare code. Google's are opaque but never contain spaces or slashes.
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}

/** Builds the URL the user opens to authorise Geode. */
export function buildAuthUrl(clientId: string, challenge: string): string {
  const params: Record<string, string> = {
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Without both of these Google returns no refresh token on a repeat sign-in.
    access_type: 'offline',
    prompt: 'consent',
  };

  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

  return `${AUTH_ENDPOINT}?${query}`;
}

/** Signs in with the installed-app redirect flow and a pasted code. */
export class PkceAuthProvider extends CachingAuthProvider {
  constructor(
    readClient: () => OAuthClient,
    tokens: RefreshTokenStore,
    private readonly crypto: CryptoProvider,
    private readonly ui: PkceFlowUi,
  ) {
    super(readClient, tokens);
  }

  override async connect(): Promise<Result<void>> {
    const client = this.readClient();
    if (client.clientId.length === 0 || client.clientSecret.length === 0) {
      return err(authError('Add your OAuth client id and secret in Geode settings first.'));
    }

    const verifier = createVerifier(this.crypto);
    const challenge = await challengeFor(this.crypto, verifier);

    const pasted = await this.ui.requestCode(buildAuthUrl(client.clientId, challenge));
    if (pasted === null) {
      return err(cancelledError('Sign-in cancelled.'));
    }

    const code = extractAuthCode(pasted);
    if (code === null) {
      return err(authError('No authorization code found in what was pasted.'));
    }

    const outcome = await postForm(TOKEN_ENDPOINT, {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    });
    if (!outcome.ok) return outcome;

    const granted = readGrantResponse(outcome.value);
    if (!granted.ok) return granted;

    return this.acceptGrant(granted.value);
  }
}
