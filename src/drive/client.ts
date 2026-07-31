import { requestUrl } from 'obsidian';
import type { RequestUrlResponse } from 'obsidian';

import { concatBytes, toArrayBuffer, toHex, utf8Encode } from '../core/bytes';
import { KEYCHECK_NAME } from '../core/container';
import { decodePath } from '../core/path-codec';
import type { Bytes, CryptoProvider, DriveFileId, DriveName, RemoteFile, Result } from '../types';
import { driveFileId, driveName, err, networkError, ok } from '../types';
import type { AuthProvider } from './auth-provider';
import type { DriveFileDto } from './dto';
import { describeErrorBody, isDriveFileDto, isDriveFileListDto, parseJson } from './dto';

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
const PAGE_SIZE = 1000;

/** appProperties Geode writes. The path is NOT among them — it would overflow. */
export interface GeodeAppProperties {
  /** Format version of the Drive-side layout. */
  readonly v: '1';
  /** Advisory encryption flag. The container MAGIC is what actually decides. */
  readonly enc: '0' | '1';
}

/** What one folder listing produced. */
export interface FolderListing {
  /** Files whose names decoded to a usable vault path. */
  readonly files: readonly RemoteFile[];
  /** The passphrase check file, if the folder has one. */
  readonly keycheckId: DriveFileId | null;
  /** Names that were not encoded paths. Reported, never touched. */
  readonly ignored: readonly string[];
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
  readonly body?: string | ArrayBuffer;
}

/** Talks to Drive. One instance per plugin load, holding the auth provider. */
export class DriveClient {
  constructor(
    private readonly auth: AuthProvider,
    private readonly crypto: CryptoProvider,
  ) {}

  /**
   * Sends a request with a bearer token, retrying once on 401.
   *
   * A 401 mid-run is normal: access tokens last an hour and a big push outlives
   * one. The retry re-derives the token rather than failing the whole operation.
   */
  private async send(spec: RequestSpec): Promise<Result<RequestUrlResponse>> {
    const first = await this.sendOnce(spec);
    if (!first.ok) return first;
    if (first.value.status !== 401) return first;

    this.auth.invalidate();
    return this.sendOnce(spec);
  }

  private async sendOnce(spec: RequestSpec): Promise<Result<RequestUrlResponse>> {
    const token = await this.auth.getAccessToken();
    if (!token.ok) return token;

    const headers: Record<string, string> = { Authorization: `Bearer ${token.value}` };

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
      url: buildUrl(DRIVE_FILES, { q: query, fields: `files(${FILE_FIELDS})`, pageSize: '10' }),
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
   * Lists every Geode file in the folder, following nextPageToken to the end.
   *
   * A partial listing would look like a set of deleted files, so a failure on
   * any page fails the whole call rather than returning what it has.
   */
  async listFolder(folderId: DriveFileId): Promise<Result<FolderListing>> {
    const files: RemoteFile[] = [];
    const ignored: string[] = [];
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
        files.push(file);
      }

      pageToken = body.nextPageToken;
    } while (pageToken !== undefined && pageToken.length > 0);

    return ok({ files, keycheckId, ignored });
  }

  /** Downloads a file's bytes. */
  async download(fileId: DriveFileId): Promise<Result<Bytes>> {
    const response = await this.send({
      url: buildUrl(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`, { alt: 'media' }),
      method: 'GET',
    });
    if (!response.ok) return response;
    if (response.value.status < 200 || response.value.status >= 300) {
      return DriveClient.failure(response.value, 'Downloading a file');
    }
    return ok(new Uint8Array(response.value.arrayBuffer));
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

  /** Creates a new file in the folder. */
  async upload(
    folderId: DriveFileId,
    name: DriveName,
    content: Bytes,
    properties: GeodeAppProperties,
  ): Promise<Result<DriveFileDto>> {
    const { body, contentType } = this.buildMultipart(
      { name, parents: [folderId], appProperties: properties },
      content,
    );

    return this.sendForFile(
      {
        url: buildUrl(DRIVE_UPLOAD, { uploadType: 'multipart', fields: FILE_FIELDS }),
        method: 'POST',
        contentType,
        body,
      },
      `Uploading ${name}`,
    );
  }

  /** Replaces an existing file's content, leaving its metadata alone. */
  async updateContent(fileId: DriveFileId, content: Bytes): Promise<Result<DriveFileDto>> {
    return this.sendForFile(
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
