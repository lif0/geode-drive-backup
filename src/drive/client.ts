import { requestUrl } from 'obsidian';
import type { RequestUrlResponse } from 'obsidian';

import { concatBytes, toArrayBuffer, toHex, utf8Encode } from '../core/bytes';
import { KEYCHECK_NAME } from '../core/container';
import { decodePath } from '../core/path-codec';
import type {
  Bytes,
  CancellationToken,
  CryptoProvider,
  DriveFileId,
  DriveName,
  RemoteFile,
  Result,
  VaultPath,
} from '../types';
import { cancelledError, driveFileId, driveName, err, networkError, ok, vaultPath } from '../types';
import type { AuthProvider } from './auth-provider';
import type { DriveFileDto } from './dto';
import {
  describeErrorBody,
  driveErrorReasons,
  isDriveFileDto,
  isDriveFileListDto,
  parseJson,
} from './dto';

/**
 * Google Drive REST v3, limited to what a backup needs.
 *
 * Storage is flat: one folder, one Drive file per vault file, path carried in
 * the file name. No folder hierarchy is mirrored, so there is no tree to keep in
 * sync and no half-created folders to clean up after a failed run.
 */

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,md5Checksum,modifiedTime,size,appProperties';
const FOLDER_FIELDS = 'id,name,mimeType,trashed';
const PAGE_SIZE = 1000;

/**
 * Statuses Drive returns when the answer is "later", not "no".
 *
 * Without this a push of any real vault half-fails: Drive answers a burst of
 * uploads with 429 or a transient 5xx, and every file that catches one is
 * reported as a failure the user is expected to do something about.
 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * The 403 reasons that also mean "later".
 *
 * 403 is the one status that needs its body read: `userRateLimitExceeded` is a
 * backoff, `storageQuotaExceeded` is a full Drive that no amount of waiting
 * fixes, and both arrive with the same status code.
 */
const RETRYABLE_403_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'sharingRateLimitExceeded',
  'backendError',
  'internalError',
]);

/** Attempts per request, the first one included. */
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 600;
const MAX_BACKOFF_MS = 20_000;
/** Cancellation is checked this often while waiting out a backoff. */
const BACKOFF_SLICE_MS = 250;

/**
 * Above this, a multipart upload is out of contract.
 *
 * Google documents `uploadType=multipart` for files of 5 MB or less and sends
 * everything larger to a resumable session. A vault's big attachments are
 * exactly the files a backup must not quietly drop, so they take that path.
 */
const MULTIPART_MAX_BYTES = 5 * 1024 * 1024;

/**
 * How much of a big file moves per request.
 *
 * `requestUrl` is a single await with no progress events, so a file sent in one
 * request tells the user nothing between "started" and "finished". Sending it in
 * pieces is what turns a frozen bar into a moving one — and it lets Cancel take
 * effect inside a single large file instead of only between files.
 *
 * Drive requires every resumable chunk but the last to be a multiple of 256 KB.
 * Downloads have no such rule and take a larger bite, since a `Range` request
 * costs a round trip and buys less: a download that stalls is obvious anyway.
 */
const UPLOAD_CHUNK_BYTES = 1024 * 1024;
const DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

/** Below this, one request is both faster and honest. Nothing to report. */
const CHUNK_THRESHOLD_BYTES = MULTIPART_MAX_BYTES;

/** Told how many bytes have crossed so far. Never called with a decrease. */
export type TransferProgress = (bytesDone: number) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads a header without caring how the platform cased the name. */
function headerValue(headers: Record<string, string>, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

/** `Retry-After` in milliseconds, when Drive sent one as a number of seconds. */
function retryAfterMs(response: RequestUrlResponse): number | null {
  const raw = headerValue(response.headers, 'retry-after');
  if (raw === null) return null;

  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

/**
 * How much of a resumable upload Drive says it has, from the `Range` header of
 * a 308. Null when it did not say, in which case the sender's own count stands.
 */
function resumeOffset(response: RequestUrlResponse): number | null {
  const raw = headerValue(response.headers, 'range');
  if (raw === null) return null;

  const match = /bytes=\d+-(\d+)/.exec(raw);
  if (match === null) return null;

  const last = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(last) ? last + 1 : null;
}

/** True when the status — and for 403, the reason — says to try again. */
function isRetryable(response: RequestUrlResponse): boolean {
  if (RETRYABLE_STATUS.has(response.status)) return true;
  if (response.status !== 403) return false;
  return driveErrorReasons(parseJson(response.text)).some((reason) =>
    RETRYABLE_403_REASONS.has(reason),
  );
}

/**
 * Picks which of two Drive files claiming one vault path to treat as the file.
 *
 * Newest wins, with the id as a tie-break, so every device makes the same choice
 * and a conflict reported on one is reported on all of them.
 */
function newerOf(a: RemoteFile, b: RemoteFile): RemoteFile {
  if (a.modifiedTime !== b.modifiedTime) return a.modifiedTime > b.modifiedTime ? a : b;
  return a.id > b.id ? a : b;
}

/** appProperties Geode writes. The path is NOT among them — it would overflow. */
export interface GeodeAppProperties {
  /** Format version of the Drive-side layout. */
  readonly v: '1';
  /** Advisory encryption flag. The container MAGIC is what actually decides. */
  readonly enc: '0' | '1';
}

/** What one folder listing produced. */
export interface FolderListing {
  /** Files whose names decoded to a usable vault path. One per path. */
  readonly files: readonly RemoteFile[];
  /** The passphrase check file, if the folder has one. */
  readonly keycheckId: DriveFileId | null;
  /** Names that were not encoded paths. Reported, never touched. */
  readonly ignored: readonly string[];
  /** Paths held by more than one Drive file. All but the newest are ignored. */
  readonly duplicates: readonly VaultPath[];
}

function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildUrl(base: string, params: Record<string, string>): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${base}?${query}`;
}

function toRemoteFile(dto: DriveFileDto): RemoteFile | null {
  const path = decodePath(dto.name);
  if (!path.ok) return null;

  return {
    id: driveFileId(dto.id),
    name: driveName(dto.name),
    path: path.value,
    md5: dto.md5Checksum ?? '',
    modifiedTime: dto.modifiedTime ?? '',
    size: Number.parseInt(dto.size ?? '0', 10) || 0,
    encryptedFlag: dto.appProperties?.['enc'] === '1',
  };
}

interface RequestSpec {
  readonly url: string;
  readonly method: string;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | ArrayBuffer;
}

/** Talks to Drive. One instance per plugin load, holding the auth provider. */
export class DriveClient {
  /**
   * `cancellation` only shortens a backoff. Requests themselves are never
   * interrupted mid-flight, so a cancelled run still leaves whole files behind,
   * never half of one.
   */
  constructor(
    private readonly auth: AuthProvider,
    private readonly crypto: CryptoProvider,
    private readonly cancellation: CancellationToken | null = null,
  ) {}

  /**
   * Sends a request with a bearer token, retrying what is worth retrying.
   *
   * Two different failures hide behind one method here:
   *
   * - **401.** Normal mid-run: access tokens last an hour and a big push
   *   outlives one. Re-derive the token and go again immediately, once.
   * - **429, 5xx, a rate-limit 403, a dropped connection.** Drive throttles a
   *   burst of uploads as a matter of course. Without a backoff every file that
   *   catches one is reported as a failure, and a push of a large vault comes
   *   back with a list of files the user is told to worry about but can only fix
   *   by running it again.
   *
   * Retrying a create can in principle produce two Drive files for one path if
   * the first attempt landed and only its response was lost. `listFolder`
   * reports that rather than hiding it.
   */
  private async send(spec: RequestSpec): Promise<Result<RequestUrlResponse>> {
    let reauthorized = false;

    for (let attempt = 1; ; attempt += 1) {
      const sent = await this.sendOnce(spec);

      if (!sent.ok) {
        // An auth failure is a decision, not a hiccup: the credentials are
        // wrong or the user cancelled a sign-in. Only transport failures retry.
        if (sent.error.kind !== 'network' || attempt >= MAX_ATTEMPTS) return sent;
        if (!(await this.backoff(attempt, null))) return sent;
        continue;
      }

      if (sent.value.status === 401 && !reauthorized) {
        reauthorized = true;
        this.auth.invalidate();
        continue;
      }

      if (attempt >= MAX_ATTEMPTS || !isRetryable(sent.value)) return sent;
      if (!(await this.backoff(attempt, retryAfterMs(sent.value)))) return sent;
    }
  }

  /**
   * Waits before the next attempt. False means the user cancelled — stop.
   *
   * Exponential, jittered, and capped. The jitter matters: without it a device
   * that just had three hundred uploads throttled retries all of them in
   * lockstep and gets throttled again in lockstep.
   */
  private async backoff(attempt: number, hintMs: number | null): Promise<boolean> {
    if (this.cancellation?.isCancelled() === true) return false;

    const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    const jittered = ceiling / 2 + Math.random() * (ceiling / 2);
    const total = Math.min(hintMs ?? jittered, MAX_BACKOFF_MS);

    // Slept in slices so Cancel does not have to wait out a twenty-second pause.
    for (let waited = 0; waited < total; waited += BACKOFF_SLICE_MS) {
      await sleep(Math.min(BACKOFF_SLICE_MS, total - waited));
      if (this.cancellation?.isCancelled() === true) return false;
    }
    return true;
  }

  private async sendOnce(spec: RequestSpec): Promise<Result<RequestUrlResponse>> {
    const token = await this.auth.getAccessToken();
    if (!token.ok) return token;

    const headers: Record<string, string> = {
      ...spec.headers,
      Authorization: `Bearer ${token.value}`,
    };

    try {
      const response = await requestUrl({
        url: spec.url,
        method: spec.method,
        headers,
        ...(spec.contentType === undefined ? {} : { contentType: spec.contentType }),
        ...(spec.body === undefined ? {} : { body: spec.body }),
        throw: false,
      });
      return ok(response);
    } catch (cause) {
      return err(networkError('Could not reach Google Drive. Check your connection.', cause));
    }
  }

  private static failure(response: RequestUrlResponse, what: string): Result<never> {
    const reason = describeErrorBody(parseJson(response.text), response.text);
    return err(networkError(`${what} failed (HTTP ${String(response.status)}): ${reason}`));
  }

  private async sendForFile(spec: RequestSpec, what: string): Promise<Result<DriveFileDto>> {
    const response = await this.send(spec);
    if (!response.ok) return response;
    if (response.value.status < 200 || response.value.status >= 300) {
      return DriveClient.failure(response.value, what);
    }

    const body = parseJson(response.value.text);
    if (!isDriveFileDto(body)) {
      return err(networkError(`${what} returned a response Geode could not read.`));
    }
    return ok(body);
  }

  /**
   * Finds the app folder by name, creating it if absent.
   *
   * With the drive.file scope this only ever sees folders Geode itself created,
   * so a same-named folder made by hand in the Drive web UI is invisible and a
   * second one gets created. That is the cost of not asking for full Drive access.
   */
  async ensureFolder(name: string): Promise<Result<DriveFileId>> {
    const query = `mimeType='${FOLDER_MIME}' and name='${escapeQueryValue(name)}' and trashed=false`;
    const response = await this.send({
      // Ordered, because Drive allows two folders with one name and returns them
      // in no particular order. Unordered, a vault whose folder got duplicated
      // would back up to whichever copy the API happened to list first, and to
      // the other one tomorrow.
      url: buildUrl(DRIVE_FILES, {
        q: query,
        fields: `files(${FOLDER_FIELDS})`,
        orderBy: 'createdTime',
        pageSize: '10',
      }),
      method: 'GET',
    });
    if (!response.ok) return response;
    if (response.value.status < 200 || response.value.status >= 300) {
      return DriveClient.failure(response.value, 'Looking up the Drive folder');
    }

    const body = parseJson(response.value.text);
    if (!isDriveFileListDto(body)) {
      return err(networkError('Drive returned a folder listing Geode could not read.'));
    }

    const existing = body.files?.[0];
    if (existing !== undefined) return ok(driveFileId(existing.id));

    const created = await this.sendForFile(
      {
        url: buildUrl(DRIVE_FILES, { fields: 'id,name' }),
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
      },
      'Creating the Drive folder',
    );
    if (!created.ok) return created;
    return ok(driveFileId(created.value.id));
  }

  /**
   * True if a cached folder id still names a live folder this client can reach.
   *
   * Worth one request per run, because the failure it catches is silent. A
   * folder that was deleted, moved to the trash, or belongs to the Google
   * account the user has just switched away from still produces a perfectly
   * well-formed empty listing. Push reads that as "Drive has nothing", decides
   * every file in the vault needs re-uploading, and then fails on each one
   * because the parent does not exist.
   */
  async folderIsUsable(folderId: DriveFileId): Promise<Result<boolean>> {
    const response = await this.send({
      url: buildUrl(`${DRIVE_FILES}/${encodeURIComponent(folderId)}`, { fields: FOLDER_FIELDS }),
      method: 'GET',
    });
    if (!response.ok) return response;

    const status = response.value.status;
    // 404: gone, or owned by an account this token no longer speaks for.
    // 403: still there, no longer ours. Both mean "go and look by name".
    if (status === 404 || status === 403) return ok(false);
    if (status < 200 || status >= 300) {
      return DriveClient.failure(response.value, 'Checking the Drive folder');
    }

    const body = parseJson(response.value.text);
    if (!isDriveFileDto(body)) {
      return err(networkError('Drive returned a folder Geode could not read.'));
    }
    return ok(body.mimeType === FOLDER_MIME && body.trashed !== true);
  }

  /**
   * Lists every Geode file in the folder, following nextPageToken to the end.
   *
   * A partial listing would look like a set of deleted files, so a failure on
   * any page fails the whole call rather than returning what it has.
   */
  async listFolder(folderId: DriveFileId): Promise<Result<FolderListing>> {
    const byPath = new Map<string, RemoteFile>();
    const ignored: string[] = [];
    const duplicates = new Set<string>();
    let keycheckId: DriveFileId | null = null;
    let pageToken: string | undefined;

    do {
      const response = await this.send({
        url: buildUrl(DRIVE_FILES, {
          q: `'${escapeQueryValue(folderId)}' in parents and trashed=false`,
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          pageSize: String(PAGE_SIZE),
          ...(pageToken === undefined ? {} : { pageToken }),
        }),
        method: 'GET',
      });
      if (!response.ok) return response;
      if (response.value.status < 200 || response.value.status >= 300) {
        return DriveClient.failure(response.value, 'Listing the Drive folder');
      }

      const body = parseJson(response.value.text);
      if (!isDriveFileListDto(body)) {
        return err(networkError('Drive returned a file listing Geode could not read.'));
      }

      for (const dto of body.files ?? []) {
        if (dto.name === KEYCHECK_NAME) {
          keycheckId = driveFileId(dto.id);
          continue;
        }
        const file = toRemoteFile(dto);
        if (file === null) {
          ignored.push(dto.name);
          continue;
        }

        // Drive has no unique-name constraint, so one vault path can end up
        // held by two files: two devices created the same note in the same
        // minute, someone copied it in the web UI, or an upload landed and only
        // its response was lost. Keeping the last one seen would make that
        // choice depend on page order and hide the other copy completely, which
        // for a backup means a note that is on Drive and is never restored.
        const rival = byPath.get(file.path);
        if (rival === undefined) {
          byPath.set(file.path, file);
          continue;
        }
        byPath.set(file.path, newerOf(rival, file));
        duplicates.add(file.path);
      }

      pageToken = body.nextPageToken;
    } while (pageToken !== undefined && pageToken.length > 0);

    return ok({
      files: [...byPath.values()],
      keycheckId,
      ignored,
      duplicates: [...duplicates].map((path) => vaultPath(path)),
    });
  }

  /**
   * Downloads a file's bytes.
   *
   * `totalBytes` comes from the folder listing. Given one, a large file is
   * fetched in ranged pieces so that progress can be reported and Cancel can
   * take effect part-way through; without one — the keycheck file, whose size
   * nobody tracks — it is fetched in a single request.
   */
  async download(
    fileId: DriveFileId,
    totalBytes = 0,
    onProgress?: TransferProgress,
  ): Promise<Result<Bytes>> {
    const url = buildUrl(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`, { alt: 'media' });

    if (totalBytes <= CHUNK_THRESHOLD_BYTES) {
      const response = await this.send({ url, method: 'GET' });
      if (!response.ok) return response;
      if (response.value.status < 200 || response.value.status >= 300) {
        return DriveClient.failure(response.value, 'Downloading a file');
      }
      const bytes = new Uint8Array(response.value.arrayBuffer);
      onProgress?.(bytes.length);
      return ok(bytes);
    }

    const parts: Bytes[] = [];
    let received = 0;

    while (received < totalBytes) {
      if (this.cancellation?.isCancelled() === true) {
        return err(cancelledError('Download stopped.'));
      }

      const last = Math.min(received + DOWNLOAD_CHUNK_BYTES, totalBytes) - 1;
      const response = await this.send({
        url,
        method: 'GET',
        headers: { Range: `bytes=${String(received)}-${String(last)}` },
      });
      if (!response.ok) return response;

      const status = response.value.status;
      if (status !== 200 && status !== 206) {
        return DriveClient.failure(response.value, 'Downloading a file');
      }

      const bytes = new Uint8Array(response.value.arrayBuffer);

      // 200 means the Range header was ignored and the whole file came back.
      // That is a complete answer, so take it and stop asking.
      if (status === 200) {
        onProgress?.(bytes.length);
        return ok(bytes);
      }

      // An empty piece before the end means the size we were given is not the
      // size Drive holds. Concatenating what we have would write a truncated
      // file into the vault, which is the one outcome a restore must not have.
      if (bytes.length === 0) {
        return err(networkError('Drive stopped sending a file before it was complete.'));
      }

      parts.push(bytes);
      received += bytes.length;
      onProgress?.(received);
    }

    return ok(concatBytes(...parts));
  }

  /**
   * Builds a multipart/related body.
   *
   * Assembled as bytes, never as a string. Concatenating binary content into a
   * JavaScript string corrupts every byte outside the BMP, which silently
   * destroys images and PDFs while leaving notes looking fine.
   */
  private buildMultipart(
    metadata: Record<string, unknown>,
    content: Bytes,
  ): { body: ArrayBuffer; contentType: string } {
    const boundary = `geode${toHex(this.crypto.getRandomValues(new Uint8Array(16)))}`;

    const head = utf8Encode(
      `--${boundary}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
    );
    const tail = utf8Encode(`\r\n--${boundary}--\r\n`);

    return {
      body: toArrayBuffer(concatBytes(head, content, tail)),
      contentType: `multipart/related; boundary=${boundary}`,
    };
  }

  /**
   * Uploads through a resumable session, which is the only supported route for
   * anything over 5 MB.
   *
   * First a request that hands Drive the metadata and gets back a session URL in
   * the `Location` header, then one PUT per chunk against that URL.
   *
   * Chunking does nothing for memory — the whole file is already in memory,
   * having been read and possibly encrypted there. What it buys is the only
   * mid-file progress available at all: `requestUrl` reports nothing until a
   * request returns, so a file sent in one piece is a bar that sits still for a
   * minute. It also lets Cancel land inside a large file rather than only
   * between files.
   *
   * Drive answers each chunk but the last with 308 "Resume Incomplete" and a
   * `Range` header saying how much it has. That is the authority on where to
   * carry on from, not our own count.
   */
  private async uploadResumable(
    method: 'POST' | 'PATCH',
    url: string,
    metadata: Record<string, unknown>,
    content: Bytes,
    what: string,
    onProgress?: TransferProgress,
  ): Promise<Result<DriveFileDto>> {
    const opened = await this.send({
      url,
      method,
      contentType: 'application/json; charset=UTF-8',
      headers: {
        'X-Upload-Content-Type': 'application/octet-stream',
        'X-Upload-Content-Length': String(content.length),
      },
      body: JSON.stringify(metadata),
    });
    if (!opened.ok) return opened;
    if (opened.value.status < 200 || opened.value.status >= 300) {
      return DriveClient.failure(opened.value, what);
    }

    const session = headerValue(opened.value.headers, 'location');
    if (session === null || session.length === 0) {
      return err(networkError(`${what} failed: Drive did not open an upload session.`));
    }

    let offset = 0;
    while (offset < content.length) {
      if (this.cancellation?.isCancelled() === true) {
        return err(cancelledError(`${what} stopped.`));
      }

      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, content.length);
      const sent = await this.send({
        url: session,
        method: 'PUT',
        contentType: 'application/octet-stream',
        headers: {
          'Content-Range': `bytes ${String(offset)}-${String(end - 1)}/${String(content.length)}`,
        },
        body: toArrayBuffer(content.subarray(offset, end)),
      });
      if (!sent.ok) return sent;

      const status = sent.value.status;

      // Not a redirect, whatever the number says: Drive means "send the rest".
      if (status === 308) {
        offset = resumeOffset(sent.value) ?? end;
        onProgress?.(offset);
        continue;
      }

      if (status < 200 || status >= 300) return DriveClient.failure(sent.value, what);

      onProgress?.(content.length);
      const body = parseJson(sent.value.text);
      if (!isDriveFileDto(body)) {
        return err(networkError(`${what} returned a response Geode could not read.`));
      }
      return ok(body);
    }

    // Every chunk was accepted and none of them was the one that finishes the
    // upload. Nothing was necessarily lost, but nothing is confirmed either.
    return err(networkError(`${what} ended without Drive confirming the file.`));
  }

  /** Creates a new file in the folder. */
  async upload(
    folderId: DriveFileId,
    name: DriveName,
    content: Bytes,
    properties: GeodeAppProperties,
    onProgress?: TransferProgress,
  ): Promise<Result<DriveFileDto>> {
    const metadata = { name, parents: [folderId], appProperties: properties };
    const what = `Uploading ${name}`;

    if (content.length > MULTIPART_MAX_BYTES) {
      return this.uploadResumable(
        'POST',
        buildUrl(DRIVE_UPLOAD, { uploadType: 'resumable', fields: FILE_FIELDS }),
        metadata,
        content,
        what,
        onProgress,
      );
    }

    const { body, contentType } = this.buildMultipart(metadata, content);
    const uploaded = await this.sendForFile(
      {
        url: buildUrl(DRIVE_UPLOAD, { uploadType: 'multipart', fields: FILE_FIELDS }),
        method: 'POST',
        contentType,
        body,
      },
      what,
    );
    if (uploaded.ok) onProgress?.(content.length);
    return uploaded;
  }

  /** Replaces an existing file's content, leaving its metadata alone. */
  async updateContent(
    fileId: DriveFileId,
    content: Bytes,
    onProgress?: TransferProgress,
  ): Promise<Result<DriveFileDto>> {
    if (content.length > MULTIPART_MAX_BYTES) {
      return this.uploadResumable(
        'PATCH',
        buildUrl(`${DRIVE_UPLOAD}/${encodeURIComponent(fileId)}`, {
          uploadType: 'resumable',
          fields: FILE_FIELDS,
        }),
        {},
        content,
        'Updating a file',
        onProgress,
      );
    }

    const updated = await this.sendForFile(
      {
        url: buildUrl(`${DRIVE_UPLOAD}/${encodeURIComponent(fileId)}`, {
          uploadType: 'media',
          fields: FILE_FIELDS,
        }),
        method: 'PATCH',
        contentType: 'application/octet-stream',
        body: toArrayBuffer(content),
      },
      'Updating a file',
    );
    if (updated.ok) onProgress?.(content.length);
    return updated;
  }

  /** Rewrites a file's appProperties. Only called when the encryption flag flips. */
  async updateAppProperties(
    fileId: DriveFileId,
    properties: GeodeAppProperties,
  ): Promise<Result<DriveFileDto>> {
    return this.sendForFile(
      {
        url: buildUrl(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`, { fields: FILE_FIELDS }),
        method: 'PATCH',
        contentType: 'application/json',
        body: JSON.stringify({ appProperties: properties }),
      },
      'Updating file properties',
    );
  }

  /**
   * Deletes a file permanently.
   *
   * Only ever called for the "mirror deletions" setting, which is off by default.
   * This does NOT move the file to the Drive trash — it is gone.
   */
  async deleteFile(fileId: DriveFileId): Promise<Result<void>> {
    const response = await this.send({
      url: `${DRIVE_FILES}/${encodeURIComponent(fileId)}`,
      method: 'DELETE',
    });
    if (!response.ok) return response;

    // 404 means someone else already deleted it, which is the outcome we wanted.
    const status = response.value.status;
    if ((status >= 200 && status < 300) || status === 404) return ok(undefined);
    return DriveClient.failure(response.value, 'Deleting a file');
  }

  /** Uploads or replaces the `__keycheck` file. */
  async putKeycheck(
    folderId: DriveFileId,
    existingId: DriveFileId | null,
    content: Bytes,
  ): Promise<Result<DriveFileId>> {
    if (existingId !== null) {
      const updated = await this.updateContent(existingId, content);
      if (!updated.ok) return updated;
      return ok(driveFileId(updated.value.id));
    }

    const { body, contentType } = this.buildMultipart(
      { name: KEYCHECK_NAME, parents: [folderId], appProperties: { v: '1', enc: '1' } },
      content,
    );
    const created = await this.sendForFile(
      {
        url: buildUrl(DRIVE_UPLOAD, { uploadType: 'multipart', fields: FILE_FIELDS }),
        method: 'POST',
        contentType,
        body,
      },
      'Uploading the keycheck file',
    );
    if (!created.ok) return created;
    return ok(driveFileId(created.value.id));
  }
}
