import type { Bytes, CryptoProvider, Result } from '../types';
import { cryptoError, err, ok } from '../types';
import { concatBytes, startsWithBytes, utf8Encode } from './bytes';
import type { KeyCache } from './kdf';
import { SALT_LENGTH, deriveKey, generateSalt } from './kdf';

/**
 * The encrypted container format.
 *
 * ```
 * MAGIC "OBEV" | VERSION 0x01 | SALT (16) | NONCE (12) | AES-256-GCM ciphertext+tag
 *      4 bytes        1 byte      16 bytes    12 bytes            rest
 * ```
 *
 * The salt travels with every file so a container can be decrypted from nothing
 * but the passphrase, which is what makes tools/decrypt.mjs possible.
 *
 * Filenames are NOT encrypted, and neither is file length. An observer with
 * access to the Drive folder learns every path in the vault and roughly how big
 * each file is.
 */

/** `OBEV`, checked on every download to decide whether a file is encrypted. */
export const MAGIC = new Uint8Array([0x4f, 0x42, 0x45, 0x56]);

/** Only version this build writes or reads. */
export const CONTAINER_VERSION = 0x01;

/** AES-GCM nonce length in bytes. 12 is the size GCM is defined for. */
export const NONCE_LENGTH = 12;

/** AES-GCM authentication tag length in bytes. */
export const TAG_LENGTH = 16;

/** MAGIC + version + salt + nonce. */
export const HEADER_LENGTH = MAGIC.length + 1 + SALT_LENGTH + NONCE_LENGTH;

/** Drive file name of the passphrase check file. Not a base64url-encoded path. */
export const KEYCHECK_NAME = '__keycheck';

/** Plaintext inside `__keycheck`. Fixed forever; changing it locks every vault out. */
export const KEYCHECK_PLAINTEXT = 'geode-drive-backup-v1';

/** The three fields a container carries alongside its ciphertext. */
export interface ContainerParts {
  readonly salt: Bytes;
  readonly nonce: Bytes;
  /** Ciphertext with the GCM tag appended, exactly as WebCrypto returns it. */
  readonly ciphertext: Bytes;
}

/**
 * True if `bytes` begins with the Geode magic number.
 *
 * This is the ONLY supported way to tell an encrypted file from a plain one.
 * File extensions and the `enc` appProperty both drift; the header does not.
 * Does NOT prove the file is intact or decryptable — only that it claims to be
 * a container.
 */
export function isContainer(bytes: Bytes): boolean {
  return startsWithBytes(bytes, MAGIC);
}

/**
 * Builds the container bytes. Pure byte assembly, no crypto.
 *
 * Does NOT check that `ciphertext` was produced with `nonce`; passing mismatched
 * parts produces a container that fails to decrypt.
 */
export function encodeContainer(
  salt: Bytes,
  nonce: Bytes,
  ciphertext: Bytes,
): Result<Bytes> {
  if (salt.length !== SALT_LENGTH) {
    return err(cryptoError(`Salt must be ${String(SALT_LENGTH)} bytes.`));
  }
  if (nonce.length !== NONCE_LENGTH) {
    return err(cryptoError(`Nonce must be ${String(NONCE_LENGTH)} bytes.`));
  }
  return ok(concatBytes(MAGIC, new Uint8Array([CONTAINER_VERSION]), salt, nonce, ciphertext));
}

/**
 * Splits container bytes into salt, nonce and ciphertext.
 *
 * Does NOT authenticate anything. A container that decodes here can still fail
 * to decrypt; only AES-GCM's tag check proves the bytes are genuine.
 */
export function decodeContainer(bytes: Bytes): Result<ContainerParts> {
  if (!isContainer(bytes)) {
    return err(cryptoError('Not a Geode container: wrong magic number.'));
  }
  if (bytes.length < HEADER_LENGTH + TAG_LENGTH) {
    return err(cryptoError('Container is truncated.'));
  }

  const version = bytes[MAGIC.length];
  if (version !== CONTAINER_VERSION) {
    return err(
      cryptoError(
        `Container version ${String(version ?? '?')} is not supported by this version of Geode.`,
      ),
    );
  }

  const saltStart = MAGIC.length + 1;
  const nonceStart = saltStart + SALT_LENGTH;
  const bodyStart = nonceStart + NONCE_LENGTH;

  return ok({
    salt: bytes.slice(saltStart, nonceStart),
    nonce: bytes.slice(nonceStart, bodyStart),
    ciphertext: bytes.slice(bodyStart),
  });
}

/**
 * Encrypts with a caller-supplied nonce.
 *
 * Exported for the golden vectors only. Reusing a nonce with the same key
 * destroys AES-GCM's confidentiality AND lets an attacker forge messages. Call
 * `encrypt` instead unless you are reproducing a recorded vector.
 */
export async function encryptWithNonce(
  crypto: CryptoProvider,
  key: CryptoKey,
  salt: Bytes,
  nonce: Bytes,
  plaintext: Bytes,
): Promise<Result<Bytes>> {
  if (nonce.length !== NONCE_LENGTH) {
    return err(cryptoError(`Nonce must be ${String(NONCE_LENGTH)} bytes.`));
  }

  try {
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: TAG_LENGTH * 8 },
      key,
      plaintext,
    );
    return encodeContainer(salt, nonce, new Uint8Array(sealed));
  } catch (cause) {
    return err(cryptoError('Encryption failed.', cause));
  }
}

/**
 * Encrypts `plaintext` into a container with a fresh random nonce.
 *
 * A new nonce every call means the ciphertext of an unchanged file changes on
 * every push. Never decide staleness by comparing ciphertext or remote md5.
 */
export async function encrypt(
  crypto: CryptoProvider,
  key: CryptoKey,
  salt: Bytes,
  plaintext: Bytes,
): Promise<Result<Bytes>> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  return encryptWithNonce(crypto, key, salt, nonce, plaintext);
}

/**
 * Decrypts a container with an already-derived key.
 *
 * Fails on the wrong key, a corrupt body or a tampered header — AES-GCM cannot
 * tell those apart, so the message says only that decryption failed.
 */
export async function decrypt(
  crypto: CryptoProvider,
  key: CryptoKey,
  container: Bytes,
): Promise<Result<Bytes>> {
  const parts = decodeContainer(container);
  if (!parts.ok) return parts;

  try {
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: parts.value.nonce, tagLength: TAG_LENGTH * 8 },
      key,
      parts.value.ciphertext,
    );
    return ok(new Uint8Array(opened));
  } catch (cause) {
    return err(cryptoError('Could not decrypt: wrong passphrase, or the file is damaged.', cause));
  }
}

/** What unlocking produced. */
export interface UnlockedVault {
  readonly key: CryptoKey;
  readonly salt: Bytes;
  /**
   * A `__keycheck` container the caller must upload, set only when this call
   * created the vault key. Null when an existing keycheck was validated.
   */
  readonly keycheckToUpload: Bytes | null;
}

/**
 * Turns a passphrase into the vault key, and caches it for the session.
 *
 * With an existing `__keycheck`, the passphrase is validated against it BEFORE
 * anything else happens — a wrong one fails here, having touched nothing. With
 * no keycheck, this is a new vault: a salt is generated and the caller is handed
 * a keycheck to upload.
 *
 * Does NOT prompt. The passphrase arrives already collected, because prompting
 * is the UI's job and this has to stay testable.
 * Does NOT persist the passphrase anywhere, and the cached key is
 * non-extractable.
 */
export async function unlockVault(
  crypto: CryptoProvider,
  cache: KeyCache,
  keycheck: Bytes | null,
  passphrase: string,
): Promise<Result<UnlockedVault>> {
  if (keycheck === null) {
    const salt = generateSalt(crypto);
    const derived = await deriveKey(crypto, passphrase, salt);
    if (!derived.ok) return derived;

    const created = await createKeycheck(crypto, derived.value, salt);
    if (!created.ok) return created;

    cache.unlock(derived.value, salt);
    return ok({ key: derived.value, salt, keycheckToUpload: created.value });
  }

  const parts = decodeContainer(keycheck);
  if (!parts.ok) {
    return err(cryptoError('The __keycheck file on Drive is damaged or not a Geode container.'));
  }

  const derived = await deriveKey(crypto, passphrase, parts.value.salt);
  if (!derived.ok) return derived;

  const verified = await verifyKeycheck(crypto, derived.value, keycheck);
  if (!verified.ok) return verified;

  cache.unlock(derived.value, parts.value.salt);
  return ok({ key: derived.value, salt: parts.value.salt, keycheckToUpload: null });
}

/** Builds the `__keycheck` container that lets a new device validate a passphrase. */
export async function createKeycheck(
  crypto: CryptoProvider,
  key: CryptoKey,
  salt: Bytes,
): Promise<Result<Bytes>> {
  return encrypt(crypto, key, salt, utf8Encode(KEYCHECK_PLAINTEXT));
}

/**
 * True if `key` opens `container` and finds the expected marker.
 *
 * Proves the passphrase matches the one that created the vault. Does NOT prove
 * any other file is intact.
 */
export async function verifyKeycheck(
  crypto: CryptoProvider,
  key: CryptoKey,
  container: Bytes,
): Promise<Result<true>> {
  const opened = await decrypt(crypto, key, container);
  if (!opened.ok) {
    return err(cryptoError('That passphrase does not match this vault.', opened.error.cause));
  }

  const expected = utf8Encode(KEYCHECK_PLAINTEXT);
  if (opened.value.length !== expected.length) {
    return err(cryptoError('The keycheck file is damaged.'));
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (opened.value[i] !== expected[i]) {
      return err(cryptoError('The keycheck file is damaged.'));
    }
  }
  return ok(true);
}
