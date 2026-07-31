/**
 * Shared domain types.
 *
 * This codebase juggles four kinds of string that look identical to the compiler
 * unless they are branded: a vault path, a Drive file id, a Drive file name
 * (base64url of the path) and a hex digest. Swapping two of them silently
 * uploads the wrong bytes to the wrong place, so they are branded and built only
 * through the constructors below.
 */

/* -------------------------------------------------------------------------- */
/* Branded strings                                                            */
/* -------------------------------------------------------------------------- */

/** Vault-relative path with forward slashes, e.g. `notes/daily/2026-08-01.md`. */
export type VaultPath = string & { readonly __brand: 'VaultPath' };

/** Opaque Google Drive file id. */
export type DriveFileId = string & { readonly __brand: 'DriveFileId' };

/** A Drive file's `name` field: base64url of the utf-8 vault path. */
export type DriveName = string & { readonly __brand: 'DriveName' };

/** Lowercase hex SHA-256 digest, 64 characters. */
export type Sha256Hex = string & { readonly __brand: 'Sha256Hex' };

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * True if `raw` is usable as a vault path. Rejects absolute paths, backslashes
 * and `..` segments so a hostile Drive file name cannot escape the vault on pull.
 */
export function isValidVaultPath(raw: string): boolean {
  if (raw.length === 0 || raw.startsWith('/') || raw.includes('\\')) return false;
  if (raw.includes('\0')) return false;
  return !raw.split('/').some((segment) => segment === '..' || segment === '.' || segment === '');
}

/** Builds a VaultPath. Throws on an invalid path — callers must validate first. */
export function vaultPath(raw: string): VaultPath {
  if (!isValidVaultPath(raw)) {
    throw new Error(`Not a valid vault path: ${JSON.stringify(raw)}`);
  }
  return raw as VaultPath;
}

/** Builds a DriveFileId. Throws if empty. */
export function driveFileId(raw: string): DriveFileId {
  if (raw.length === 0) throw new Error('Drive file id must not be empty');
  return raw as DriveFileId;
}

/** True if `raw` is unpadded base64url, the shape every Geode Drive name has. */
export function isValidDriveName(raw: string): boolean {
  return raw.length > 0 && BASE64URL_PATTERN.test(raw);
}

/** Builds a DriveName. Throws unless `raw` is unpadded base64url. */
export function driveName(raw: string): DriveName {
  if (!isValidDriveName(raw)) {
    throw new Error(`Not a valid Drive name: ${JSON.stringify(raw)}`);
  }
  return raw as DriveName;
}

/** True if `raw` is a 64-character lowercase hex digest. */
export function isValidSha256Hex(raw: string): boolean {
  return SHA256_HEX_PATTERN.test(raw);
}

/** Builds a Sha256Hex. Throws unless `raw` is 64 lowercase hex characters. */
export function sha256Hex(raw: string): Sha256Hex {
  if (!isValidSha256Hex(raw)) {
    throw new Error(`Not a SHA-256 hex digest: ${JSON.stringify(raw)}`);
  }
  return raw as Sha256Hex;
}

/* -------------------------------------------------------------------------- */
/* Result and errors                                                          */
/* -------------------------------------------------------------------------- */

/** Outcome of a fallible operation. Modules return this instead of throwing. */
export type Result<T, E = AppError> = { ok: true; value: T } | { ok: false; error: E };

/** Wraps a success value. */
export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

/** Wraps a failure. */
export function err<E = AppError>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}

/** The kinds of failure Geode distinguishes. */
export type AppErrorKind = 'auth' | 'network' | 'crypto' | 'io' | 'conflict' | 'cancelled';

interface ErrorShape<K extends AppErrorKind> {
  readonly kind: K;
  /** Shown to the user verbatim. Must not contain tokens or passphrases. */
  readonly message: string;
  readonly cause?: unknown;
}

/** Missing, rejected or expired Google credentials. */
export type AuthError = ErrorShape<'auth'>;
/** HTTP transport failure or an unexpected Drive response. */
export type NetworkError = ErrorShape<'network'>;
/** Bad passphrase, corrupt container or an unsupported container version. */
export type CryptoError = ErrorShape<'crypto'>;
/** Vault read/write failure. */
export type IoError = ErrorShape<'io'>;
/** Another device changed a file Geode was about to overwrite. */
export type ConflictError = ErrorShape<'conflict'>;
/** The user aborted the operation. */
export type CancelledError = ErrorShape<'cancelled'>;

/** Every failure Geode can report. */
export type AppError =
  | AuthError
  | NetworkError
  | CryptoError
  | IoError
  | ConflictError
  | CancelledError;

function makeError<K extends AppErrorKind>(kind: K, message: string, cause?: unknown): ErrorShape<K> {
  return cause === undefined ? { kind, message } : { kind, message, cause };
}

/** Builds an auth error. */
export const authError = (message: string, cause?: unknown): AuthError =>
  makeError('auth', message, cause);

/** Builds a network error. */
export const networkError = (message: string, cause?: unknown): NetworkError =>
  makeError('network', message, cause);

/** Builds a crypto error. */
export const cryptoError = (message: string, cause?: unknown): CryptoError =>
  makeError('crypto', message, cause);

/** Builds an I/O error. */
export const ioError = (message: string, cause?: unknown): IoError =>
  makeError('io', message, cause);

/** Builds a conflict error. */
export const conflictError = (message: string, cause?: unknown): ConflictError =>
  makeError('conflict', message, cause);

/** Builds a cancellation error. */
export const cancelledError = (message: string, cause?: unknown): CancelledError =>
  makeError('cancelled', message, cause);

/* -------------------------------------------------------------------------- */
/* Injected capabilities                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Bytes backed by a plain ArrayBuffer.
 *
 * Since TypeScript 5.7 `Uint8Array` is generic over its backing buffer, and
 * WebCrypto's `BufferSource` accepts only the ArrayBuffer flavour. Naming it
 * once keeps that constraint out of every signature.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * The slice of WebCrypto Geode uses. Injected rather than read off the global so
 * src/core stays testable: Obsidian passes the global `crypto`, tests pass Node's
 * `webcrypto` (Vitest's node environment has no global `crypto` on Node 18).
 */
export interface CryptoProvider {
  readonly subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

/** One file in the vault, as seen by the enumerator. */
export interface VaultFileStat {
  readonly path: VaultPath;
  readonly mtime: number;
  readonly size: number;
}

/**
 * Vault access, narrowed to what push and pull need. Backed by
 * `app.vault.adapter` plus `app.vault.getFiles()`; injected so ops can be reasoned
 * about without Obsidian.
 */
export interface VaultIo {
  /** Every file Obsidian tracks. Excludes `.obsidian/`, which holds our own tokens. */
  listFiles(): Promise<readonly VaultFileStat[]>;
  readBinary(path: VaultPath): Promise<Bytes>;
  writeBinary(path: VaultPath, data: Bytes): Promise<void>;
  exists(path: VaultPath): Promise<boolean>;
  /** Creates every missing folder above `path`. */
  ensureParentFolder(path: VaultPath): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Local index                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What Geode remembers about one pushed file.
 *
 * `sha256` is always the digest of the PLAINTEXT, taken before encryption, and
 * never leaves this device — publishing it would let anyone confirm a guess at
 * the contents of an encrypted file.
 */
export interface IndexEntry {
  readonly sha256: Sha256Hex;
  readonly driveFileId: DriveFileId;
  /** The md5 Drive reported for the bytes we last wrote. Detects other devices. */
  readonly remoteMd5: string;
  readonly mtime: number;
}

/** Path to index entry. Lives in data.json and is never uploaded. */
export type LocalIndex = Record<VaultPath, IndexEntry>;

/** One file on the local side of a diff. */
export interface LocalFile {
  readonly path: VaultPath;
  readonly sha256: Sha256Hex;
  readonly mtime: number;
  readonly size: number;
}

/** One Geode file in the Drive folder, with its name already decoded to a path. */
export interface RemoteFile {
  readonly id: DriveFileId;
  readonly name: DriveName;
  readonly path: VaultPath;
  /** Empty string when Drive omits it, which it does for some file types. */
  readonly md5: string;
  readonly modifiedTime: string;
  readonly size: number;
  /** From appProperties. Advisory only — the container MAGIC is authoritative. */
  readonly encryptedFlag: boolean;
}

/* -------------------------------------------------------------------------- */
/* Action plans                                                               */
/* -------------------------------------------------------------------------- */

/** Why a file was left alone. */
export type SkipReason =
  | 'unchanged'
  | 'remote-changed-locally-unchanged'
  | 'deleted-locally'
  | 'already-identical';

/** One step of a push. Produced by planPush, executed by ops/push.ts. */
export type PushAction =
  | { readonly type: 'upload'; readonly path: VaultPath; readonly encrypt: boolean }
  | {
      readonly type: 'update';
      readonly path: VaultPath;
      readonly fileId: DriveFileId;
      readonly encrypt: boolean;
    }
  | { readonly type: 'delete-remote'; readonly path: VaultPath; readonly fileId: DriveFileId }
  | { readonly type: 'conflict'; readonly path: VaultPath; readonly fileId: DriveFileId | null }
  | { readonly type: 'skip'; readonly path: VaultPath; readonly reason: SkipReason };

/** One step of a pull. Produced by planPull, executed by ops/pull.ts. */
export type PullAction =
  | {
      readonly type: 'download';
      readonly path: VaultPath;
      readonly fileId: DriveFileId;
      readonly writeTo: VaultPath;
    }
  | {
      readonly type: 'rename-on-collision';
      readonly path: VaultPath;
      readonly fileId: DriveFileId;
      readonly writeTo: VaultPath;
    }
  | { readonly type: 'skip'; readonly path: VaultPath; readonly reason: SkipReason };

/** An ordered push plan. */
export interface PushPlan {
  readonly actions: readonly PushAction[];
}

/** An ordered pull plan. */
export interface PullPlan {
  readonly actions: readonly PullAction[];
}

/* -------------------------------------------------------------------------- */
/* Progress and summaries                                                     */
/* -------------------------------------------------------------------------- */

/** What a finished push or pull did. Rendered as the closing Notice. */
export interface OperationSummary {
  readonly operation: 'push' | 'pull';
  readonly uploaded: number;
  readonly updated: number;
  readonly downloaded: number;
  readonly renamed: number;
  readonly deleted: number;
  readonly skipped: number;
  readonly conflicts: readonly VaultPath[];
  readonly failures: readonly { readonly path: VaultPath; readonly message: string }[];
}

/** Progress sink. The Notice-based implementation lives in ui/progress.ts. */
export interface ProgressReporter {
  begin(label: string, total: number): void;
  advance(label: string): void;
  done(summary: OperationSummary): void;
  fail(error: AppError): void;
}
