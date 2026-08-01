/**
 * Shapes Google returns, and the guards that prove a response really has them.
 *
 * Every response body arrives as `unknown` and must pass through a guard here
 * before any field is read. No `as` casts on network data: Google adds and
 * removes fields, error bodies come back where success bodies were expected, and
 * a proxy or captive portal can return HTML with a 200.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/* ------------------------------- Drive files ------------------------------ */

/** One entry from `files.list`, limited to the fields Geode requests. */
export interface DriveFileDto {
  readonly id: string;
  readonly name: string;
  readonly md5Checksum?: string;
  readonly modifiedTime?: string;
  readonly size?: string;
  readonly mimeType?: string;
  /** True once the file — or any folder above it — is in the Drive trash. */
  readonly trashed?: boolean;
  readonly appProperties?: Record<string, string>;
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string');
}

/** True if `value` is a Drive file object with at least an id and a name. */
export function isDriveFileDto(value: unknown): value is DriveFileDto {
  if (!isRecord(value)) return false;
  if (typeof value['id'] !== 'string' || value['id'].length === 0) return false;
  if (typeof value['name'] !== 'string') return false;
  if (!optionalString(value['md5Checksum'])) return false;
  if (!optionalString(value['modifiedTime'])) return false;
  if (!optionalString(value['size'])) return false;
  if (!optionalString(value['mimeType'])) return false;
  if (value['trashed'] !== undefined && typeof value['trashed'] !== 'boolean') return false;

  const appProperties = value['appProperties'];
  return appProperties === undefined || isStringMap(appProperties);
}

/**
 * `about.get`, limited to the storage figures.
 *
 * Every number is a string: these are int64 values, and a Drive quota in bytes
 * outgrows what a JSON number can carry exactly.
 */
export interface DriveAboutDto {
  readonly storageQuota?: {
    /** Absent on accounts Drive treats as having no limit. */
    readonly limit?: string;
    readonly usage?: string;
  };
}

/** True if `value` is an about response with a readable storageQuota, or none. */
export function isDriveAboutDto(value: unknown): value is DriveAboutDto {
  if (!isRecord(value)) return false;

  const quota = value['storageQuota'];
  if (quota === undefined) return true;
  if (!isRecord(quota)) return false;

  return optionalString(quota['limit']) && optionalString(quota['usage']);
}

/** One page of `files.list`. */
export interface DriveFileListDto {
  /** Absent, not empty, when the folder has no files. */
  readonly files?: readonly DriveFileDto[];
  readonly nextPageToken?: string;
}

/**
 * True if `value` is a list page.
 *
 * A missing `files` array means an empty folder, which Drive reports by omitting
 * the key entirely. Any entry that fails `isDriveFileDto` fails the whole page —
 * silently dropping one would look like a deleted file and, with deletion
 * mirroring on, could delete the local copy.
 */
export function isDriveFileListDto(value: unknown): value is DriveFileListDto {
  if (!isRecord(value)) return false;
  if (!optionalString(value['nextPageToken'])) return false;

  const files = value['files'];
  if (files === undefined) return true;
  return Array.isArray(files) && files.every(isDriveFileDto);
}

/* --------------------------------- OAuth ---------------------------------- */

/** A successful response from the token endpoint. */
export interface TokenResponseDto {
  readonly access_token: string;
  readonly expires_in: number;
  readonly token_type: string;
  readonly refresh_token?: string;
  readonly scope?: string;
}

/** True if `value` carries a usable access token and a lifetime. */
export function isTokenResponseDto(value: unknown): value is TokenResponseDto {
  if (!isRecord(value)) return false;
  if (typeof value['access_token'] !== 'string' || value['access_token'].length === 0) return false;
  if (typeof value['expires_in'] !== 'number') return false;
  if (typeof value['token_type'] !== 'string') return false;
  if (!optionalString(value['refresh_token'])) return false;
  return optionalString(value['scope']);
}

/** The device authorization response. */
export interface DeviceCodeDto {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_url: string;
  readonly expires_in: number;
  readonly interval?: number;
}

/**
 * True if `value` is a device authorization response.
 *
 * Google returns `verification_url`; the RFC 8628 name is `verification_uri`.
 * Both are accepted, and the value is normalised by `readVerificationUrl`.
 */
export function isDeviceCodeDto(value: unknown): value is DeviceCodeDto {
  if (!isRecord(value)) return false;
  if (typeof value['device_code'] !== 'string' || value['device_code'].length === 0) return false;
  if (typeof value['user_code'] !== 'string' || value['user_code'].length === 0) return false;
  if (typeof value['expires_in'] !== 'number') return false;
  if (value['interval'] !== undefined && typeof value['interval'] !== 'number') return false;

  const url = value['verification_url'] ?? value['verification_uri'];
  return typeof url === 'string' && url.length > 0;
}

/** Pulls the verification URL out from under either spelling. */
export function readVerificationUrl(value: unknown): string {
  if (!isRecord(value)) return '';
  const url = value['verification_url'] ?? value['verification_uri'];
  return typeof url === 'string' ? url : '';
}

/** An OAuth error body. Also used for the polling states of the device flow. */
export interface OAuthErrorDto {
  readonly error: string;
  readonly error_description?: string;
}

/** True if `value` is an OAuth error body. */
export function isOAuthErrorDto(value: unknown): value is OAuthErrorDto {
  if (!isRecord(value)) return false;
  if (typeof value['error'] !== 'string' || value['error'].length === 0) return false;
  return optionalString(value['error_description']);
}

/* ------------------------------ Drive errors ------------------------------ */

/** The `{ error: { code, message } }` envelope the Drive API returns. */
export interface DriveErrorDto {
  readonly error: { readonly code: number; readonly message: string };
}

/** True if `value` is a Drive API error envelope. */
export function isDriveErrorDto(value: unknown): value is DriveErrorDto {
  if (!isRecord(value)) return false;
  const error = value['error'];
  if (!isRecord(error)) return false;
  return typeof error['code'] === 'number' && typeof error['message'] === 'string';
}

/**
 * The machine-readable `reason` codes out of a Drive error body.
 *
 * The HTTP status alone is not enough to decide whether to retry. Drive answers
 * a burst of uploads with 403 and `userRateLimitExceeded`, which is transient
 * and wants a backoff, using the same status it returns for
 * `storageQuotaExceeded`, which no amount of waiting will fix. The reason lives
 * in `error.errors[].reason`; older and stranger error shapes simply yield an
 * empty list.
 */
export function driveErrorReasons(body: unknown): readonly string[] {
  if (!isRecord(body)) return [];
  const error = body['error'];
  if (!isRecord(error)) return [];

  const errors = error['errors'];
  if (!Array.isArray(errors)) return [];

  const reasons: string[] = [];
  for (const item of errors) {
    if (!isRecord(item)) continue;
    const reason = item['reason'];
    if (typeof reason === 'string') reasons.push(reason);
  }
  return reasons;
}

/**
 * Best-effort human-readable reason from any error body.
 *
 * Falls back to the raw text so a proxy's HTML error page still tells the user
 * something, truncated because it can be an entire document.
 */
export function describeErrorBody(body: unknown, fallbackText: string): string {
  if (isDriveErrorDto(body)) return body.error.message;
  if (isOAuthErrorDto(body)) {
    return body.error_description === undefined
      ? body.error
      : `${body.error}: ${body.error_description}`;
  }
  const trimmed = fallbackText.trim();
  if (trimmed.length === 0) return 'no response body';
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

/**
 * Parses a JSON body without trusting it.
 *
 * Returns null rather than throwing on malformed JSON; the caller reports the
 * HTTP status, which is more useful than a parse error.
 */
export function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}
