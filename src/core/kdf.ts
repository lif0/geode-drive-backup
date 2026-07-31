import type { Bytes, CryptoProvider, Result } from '../types';
import { cryptoError, err, ok } from '../types';
import { utf8Encode } from './bytes';

/**
 * PBKDF2 key derivation and the in-memory key cache.
 *
 * Deriving a key costs roughly a second. Doing it per file freezes Obsidian on a
 * vault of any size, so the key is derived once per unlock and held in memory
 * until the plugin unloads.
 */

/** OWASP's 2023 floor for PBKDF2-HMAC-SHA256. */
export const PBKDF2_ITERATIONS = 600_000;

/** AES-256. */
export const KEY_LENGTH_BITS = 256;

/** Salt length in bytes, matching the container header. */
export const SALT_LENGTH = 16;

/**
 * Derives the AES-GCM key for `passphrase` and `salt`.
 *
 * Does NOT verify the passphrase — any passphrase yields a key. Use the
 * `__keycheck` file to find out whether that key is the right one.
 * Does NOT protect against a weak passphrase; 600k iterations only raises the
 * cost per guess.
 */
export async function deriveKey(
  crypto: CryptoProvider,
  passphrase: string,
  salt: Bytes,
): Promise<Result<CryptoKey>> {
  if (salt.length !== SALT_LENGTH) {
    return err(cryptoError(`Salt must be ${String(SALT_LENGTH)} bytes, got ${String(salt.length)}.`));
  }

  try {
    const material = await crypto.subtle.importKey(
      'raw',
      utf8Encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey'],
    );

    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: KEY_LENGTH_BITS },
      false,
      ['encrypt', 'decrypt'],
    );

    return ok(key);
  } catch (cause) {
    return err(cryptoError('Could not derive an encryption key.', cause));
  }
}

/** Generates a fresh random salt. */
export function generateSalt(crypto: CryptoProvider): Bytes {
  return crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
}

/**
 * Holds the derived key for the session.
 *
 * The passphrase itself is never stored, here or anywhere else. The key is a
 * non-extractable CryptoKey, so it cannot be read back out of this object.
 */
export class KeyCache {
  private key: CryptoKey | null = null;
  private salt: Bytes | null = null;

  /** True once a passphrase has been accepted this session. */
  isUnlocked(): boolean {
    return this.key !== null;
  }

  /** The cached key, or null if locked. */
  getKey(): CryptoKey | null {
    return this.key;
  }

  /** The salt the cached key was derived from, or null if locked. */
  getSalt(): Bytes | null {
    return this.salt;
  }

  /** Stores a derived key for the session. */
  unlock(key: CryptoKey, salt: Bytes): void {
    this.key = key;
    this.salt = salt;
  }

  /** Drops the key. Called from the plugin's onunload. */
  clear(): void {
    this.key = null;
    this.salt = null;
  }
}
