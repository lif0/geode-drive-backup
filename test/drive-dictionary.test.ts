import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestUrl } from './obsidian-stub';
import { DriveClient } from '../src/drive/client';
import {
  DICTIONARY_NAME,
  DICTIONARY_BACKUP_NAME,
  emptyDictionary,
} from '../src/core/path-dictionary';
import type { PathDictionary } from '../src/core/path-dictionary';
import { encodePath } from '../src/core/path-codec';
import { toArrayBuffer, utf8Encode } from '../src/core/bytes';
import type { CryptoProvider } from '../src/types';
import { driveFileId, ok, vaultPath } from '../src/types';

const crypto = webcrypto as unknown as CryptoProvider;
const dictionary: PathDictionary = { version: 1, rules: [{ id: 1, text: 'Notes', enabled: true }] };
const folder = driveFileId('folder');
const objectsFolder = {
  id: 'objects-id',
  name: 'objects',
  mimeType: 'application/vnd.google-apps.folder',
};

function client(): DriveClient {
  return new DriveClient(
    {
      isConnected: () => true,
      connect: () => Promise.resolve(ok(undefined)),
      getAccessToken: () => Promise.resolve(ok('token')),
      invalidate: () => undefined,
      disconnect: () => Promise.resolve(),
    },
    crypto,
  );
}

function respond(body: unknown, status = 200): void {
  const text = JSON.stringify(body);
  requestUrl.mockResolvedValueOnce({
    status,
    headers: {},
    text,
    json: body,
    arrayBuffer: toArrayBuffer(utf8Encode(text)),
  });
}

beforeEach(() => {
  requestUrl.mockReset();
});

describe('Drive dictionary listing', () => {
  it('rejects damaged UTF-8 rather than changing the meaning of a rule', async () => {
    respond({ files: [{ id: 'dict', name: DICTIONARY_NAME }, objectsFolder] });
    respond({ files: [] });
    const bytes = new Uint8Array([
      ...utf8Encode('{"version":1,"rules":[{"id":1,"text":"'),
      255,
      ...utf8Encode('","enabled":true}]}'),
    ]);
    requestUrl.mockResolvedValueOnce({
      status: 200,
      headers: {},
      text: '',
      json: null,
      arrayBuffer: toArrayBuffer(bytes),
    });
    expect((await client().listFolder(folder)).ok).toBe(false);
  });
  it('reads all pages before decoding names using the dictionary', async () => {
    const name = encodePath(vaultPath('Notes/a.md'), dictionary);
    respond({
      files: [objectsFolder, { id: 'key', name: '__keycheck' }],
      nextPageToken: 'root-next',
    });
    respond({ files: [{ id: 'dict', name: DICTIONARY_NAME }] });
    respond({ files: [{ id: 'file', name, md5Checksum: 'abc' }], nextPageToken: 'objects-next' });
    respond({ files: [{ id: 'other', name: encodePath(vaultPath('Notes/b.md'), dictionary) }] });
    respond(dictionary);
    const result = await client().listFolder(folder);
    expect(result.ok && result.value.files[0]?.path).toBe('Notes/a.md');
    expect(result.ok && result.value.dictionaryId).toBe('dict');
    expect(result.ok && result.value.objectsFolderId).toBe('objects-id');
    expect(result.ok && result.value.keycheckId).toBe('key');
    expect(result.ok && result.value.files).toHaveLength(2);
    expect(decodeURIComponent(requestUrl.mock.calls[2]?.[0].url ?? '')).toContain(
      "'objects-id' in parents",
    );
    expect(requestUrl).toHaveBeenCalledTimes(5);
  });

  it('requires the dictionary even for names with no tokens', async () => {
    respond({ files: [objectsFolder] });
    respond({ files: [{ id: 'file', name: encodePath(vaultPath('note.md')) }] });
    expect((await client().listFolder(folder)).ok).toBe(false);
  });

  it('does not treat a surviving backup dictionary as an empty folder', async () => {
    respond({ files: [{ id: 'backup', name: DICTIONARY_BACKUP_NAME }] });
    expect((await client().listFolder(folder)).ok).toBe(false);
  });

  it('refuses duplicate dictionaries instead of selecting the newest', async () => {
    respond({
      files: [
        { id: 'a', name: DICTIONARY_NAME },
        { id: 'b', name: DICTIONARY_NAME },
      ],
    });
    expect((await client().listFolder(folder)).ok).toBe(false);
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  it('fails the whole listing on unknown tokens or corrupt dictionaries', async () => {
    for (const value of [emptyDictionary(), { version: 999 }]) {
      respond({
        files: [{ id: 'dict', name: DICTIONARY_NAME }, objectsFolder],
      });
      respond({ files: [{ id: 'file', name: encodePath(vaultPath('Notes/a.md'), dictionary) }] });
      respond(value);
      expect((await client().listFolder(folder)).ok).toBe(false);
    }
  });

  it('identifies duplicate files by decoded path even with different encodings', async () => {
    respond({ files: [{ id: 'dict', name: DICTIONARY_NAME }, objectsFolder] });
    respond({
      files: [
        { id: 'a', name: encodePath(vaultPath('Notes/a.md')) },
        { id: 'b', name: encodePath(vaultPath('Notes/a.md'), dictionary) },
      ],
    });
    respond(dictionary);
    const result = await client().listFolder(folder);
    expect(result.ok && result.value.files).toHaveLength(1);
    expect(result.ok && result.value.duplicates).toEqual(['Notes/a.md']);
  });

  it('rejects legacy Geode backups rather than silently mixing formats', async () => {
    respond({ files: [{ id: 'old', name: 'bm90ZS5tZA', appProperties: { v: '1' } }] });
    expect((await client().listFolder(folder)).ok).toBe(false);
  });

  it('permits a fresh empty root without creating a folder during listing', async () => {
    respond({ files: [] });
    const result = await client().listFolder(folder);
    expect(result.ok && result.value.objectsFolderId).toBeNull();
    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(requestUrl.mock.calls[0]?.[0].method).toBe('GET');
  });

  it('permits an empty objects folder left by an interrupted first push', async () => {
    respond({ files: [objectsFolder] });
    respond({ files: [] });
    const result = await client().listFolder(folder);
    expect(result.ok && result.value.dictionary).toBeNull();
    expect(result.ok && result.value.objectsFolderId).toBe('objects-id');
  });

  it.each([
    [{ id: 'dict', name: DICTIONARY_NAME }],
    [objectsFolder, { ...objectsFolder, id: 'duplicate' }],
    [{ id: 'wrong', name: 'objects', mimeType: 'text/plain' }],
  ])('rejects missing or ambiguous objects directories: %j', async (...files) => {
    respond({ files });
    expect((await client().listFolder(folder)).ok).toBe(false);
  });

  it('does not return a partial backup if the objects listing fails', async () => {
    respond({ files: [objectsFolder, { id: 'dict', name: DICTIONARY_NAME }] });
    respond({ error: { code: 404, message: 'missing folder' } }, 404);
    expect((await client().listFolder(folder)).ok).toBe(false);
  });

  it('rejects flat tokenized files in the root', async () => {
    respond({ files: [objectsFolder, { id: 'file', name: encodePath(vaultPath('note.md')) }] });
    expect((await client().listFolder(folder)).ok).toBe(false);
  });
});

describe('dictionary writes', () => {
  it('creates objects under the backup root with a preallocated ID', async () => {
    respond({ ids: ['new-objects'] });
    respond({ ...objectsFolder, id: 'new-objects' });
    expect(await client().createObjectsFolder(folder)).toEqual(ok('new-objects'));
    expect(requestUrl.mock.calls[1]?.[0].body).toBe(
      JSON.stringify({
        id: 'new-objects',
        name: 'objects',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['folder'],
      }),
    );
  });
  it('allocates a server ID before creation so retries cannot create duplicates', async () => {
    respond({ ids: ['allocated'] });
    respond({ id: 'allocated', name: DICTIONARY_NAME });
    expect(await client().writeDictionary(folder, null, utf8Encode('{}'), false)).toEqual(
      ok('allocated'),
    );
    const first = requestUrl.mock.calls[0]?.[0];
    const second = requestUrl.mock.calls[1]?.[0];
    expect(first?.url).toContain('/generateIds?');
    expect(second?.method).toBe('POST');
    expect(second?.body).toBeInstanceOf(ArrayBuffer);
    if (second?.body instanceof ArrayBuffer) {
      expect(new TextDecoder().decode(second.body)).toContain('"id":"allocated"');
    }
  });

  it('uses the same allocated ID when a create is retried', async () => {
    vi.useFakeTimers();
    try {
      respond({ ids: ['allocated'] });
      respond({ error: { code: 500, message: 'retry' } }, 500);
      respond({ id: 'allocated', name: DICTIONARY_NAME });
      const pending = client().writeDictionary(folder, null, utf8Encode('{}'), false);
      await vi.runAllTimersAsync();
      expect((await pending).ok).toBe(true);
      expect(requestUrl.mock.calls[1]?.[0].body).toEqual(requestUrl.mock.calls[2]?.[0].body);
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates the existing dictionary content instead of deleting it', async () => {
    respond({ id: 'dict', name: DICTIONARY_NAME });
    expect(
      (await client().writeDictionary(folder, driveFileId('dict'), utf8Encode('{}'), false)).ok,
    ).toBe(true);
    expect(requestUrl.mock.calls[0]?.[0].method).toBe('PATCH');
  });
});
