/* eslint-disable @typescript-eslint/unbound-method -- All inspected Drive methods are spies; assertions never invoke them without a receiver. */
import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DriveClient } from '../src/drive/client';
import type { FolderListing } from '../src/drive/client';
import { defaultSettings } from '../src/settings';
import { IndexStore } from '../src/ops/index-store';
import { runPush } from '../src/ops/push';
import type { PushDeps } from '../src/ops/push';
import { KeyCache } from '../src/core/kdf';
import { hashBytes, utf8Encode } from '../src/core/bytes';
import { emptyDictionary } from '../src/core/path-dictionary';
import { decodePath, encodePath } from '../src/core/path-codec';
import type { CryptoProvider, RemoteFile } from '../src/types';
import { driveFileId, err, ioError, ok, vaultPath } from '../src/types';

const crypto = webcrypto as unknown as CryptoProvider;
const data = utf8Encode('unchanged content');
const emptyListing: FolderListing = {
  files: [],
  keycheckId: null,
  ignored: [],
  duplicates: [],
  dictionary: null,
  dictionaryId: null,
  dictionaryBackupId: null,
  objectsFolderId: null,
};

function setup(path: string): { deps: PushDeps; events: string[] } {
  const events: string[] = [];
  const drive = new DriveClient(
    {
      isConnected: () => true,
      connect: () => Promise.resolve(ok(undefined)),
      getAccessToken: () => Promise.resolve(ok('token')),
      invalidate: () => undefined,
      disconnect: () => Promise.resolve(),
    },
    crypto,
  );
  vi.spyOn(drive, 'createObjectsFolder').mockImplementation(() => {
    events.push('objects');
    return Promise.resolve(ok(driveFileId('objects-id')));
  });
  vi.spyOn(drive, 'folderIsUsable').mockResolvedValue(ok(true));
  vi.spyOn(drive, 'listFolder').mockResolvedValue(ok(emptyListing));
  vi.spyOn(drive, 'writeDictionary').mockImplementation(() => {
    events.push('dictionary');
    return Promise.resolve(ok(driveFileId('dictionary')));
  });
  vi.spyOn(drive, 'upload').mockImplementation((_folder, name) => {
    events.push('upload');
    return Promise.resolve(ok({ id: 'file', name, md5Checksum: 'md5' }));
  });
  vi.spyOn(drive, 'renameFile').mockImplementation((id, name) => {
    events.push('rename');
    return Promise.resolve(ok({ id, name, md5Checksum: 'md5' }));
  });
  vi.spyOn(drive, 'updateContent').mockResolvedValue(
    ok({ id: 'file', name: 'unused', md5Checksum: 'md5' }),
  );
  vi.spyOn(drive, 'deleteFile').mockResolvedValue(ok(undefined));
  const settings = defaultSettings();
  settings.folderId = 'folder';
  settings.pathDictionary = {
    version: 1,
    rules: [{ id: 1, text: 'Data Structures', enabled: true }],
  };
  const deps: PushDeps = {
    drive,
    settings,
    crypto,
    index: new IndexStore({}, () => Promise.resolve()),
    keys: new KeyCache(),
    cancellation: { isCancelled: () => false },
    requestPassphrase: () => Promise.resolve(null),
    rememberFolderId: () => Promise.resolve(),
    rememberDictionary: (dictionary, folderId) => {
      settings.pathDictionary = dictionary;
      settings.dictionaryFolderId = folderId;
      return Promise.resolve();
    },
    vault: {
      listFiles: () => Promise.resolve([{ path: vaultPath(path), mtime: 1, size: data.length }]),
      readBinary: () => Promise.resolve(data),
      writeBinary: () => Promise.resolve(),
      exists: () => Promise.resolve(false),
      ensureParentFolder: () => Promise.resolve(),
    },
    progress: {
      begin: vi.fn(),
      beginFile: vi.fn(),
      fileProgress: vi.fn(),
      advance: vi.fn(),
      note: vi.fn(),
      done: vi.fn(),
      fail: vi.fn(),
    },
  };
  return { deps, events };
}

async function indexedFile(deps: PushDeps, path: string): Promise<RemoteFile> {
  const typed = vaultPath(path);
  deps.index.set(typed, {
    sha256: await hashBytes(crypto, data),
    driveFileId: driveFileId('existing'),
    remoteMd5: 'md5',
    mtime: 1,
    size: data.length,
  });
  return {
    path: typed,
    id: driveFileId('existing'),
    name: encodePath(typed),
    md5: 'md5',
    size: data.length,
    modifiedTime: '',
    encryptedFlag: false,
  };
}

describe('push with path replacements', () => {
  it('stops before publishing metadata or files when objects creation fails', async () => {
    const { deps } = setup('note.md');
    vi.mocked(deps.drive.createObjectsFolder).mockResolvedValue(err(ioError('permission denied')));
    expect((await runPush(deps)).ok).toBe(false);
    expect(deps.drive.writeDictionary).not.toHaveBeenCalled();
    expect(deps.drive.upload).not.toHaveBeenCalled();
  });
  it('publishes the dictionary before uploading names that reference it', async () => {
    const { deps, events } = setup('Data Structures/note.md');
    const result = await runPush(deps);
    expect(result.ok && result.value.uploaded).toBe(1);
    expect(events).toEqual(['objects', 'dictionary', 'upload']);
    expect(vi.mocked(deps.drive.upload).mock.calls[0]?.[0]).toBe('objects-id');
    expect(vi.mocked(deps.drive.writeDictionary).mock.calls[0]?.[0]).toBe('folder');
    const name = vi.mocked(deps.drive.upload).mock.calls[0]?.[1];
    expect(name && decodePath(name, deps.settings.pathDictionary)).toEqual(
      ok('Data Structures/note.md'),
    );
  });

  it('does not upload, rename or delete if dictionary publication fails', async () => {
    const { deps } = setup('Data Structures/note.md');
    vi.mocked(deps.drive.writeDictionary).mockResolvedValue(err(ioError('offline')));
    expect((await runPush(deps)).ok).toBe(false);
    expect(deps.drive.upload).not.toHaveBeenCalled();
    expect(deps.drive.renameFile).not.toHaveBeenCalled();
    expect(deps.drive.deleteFile).not.toHaveBeenCalled();
  });

  it('checks all planned names before publishing anything or mirroring deletions', async () => {
    const { deps, events } = setup('a'.repeat(250) + '.md');
    const old = await indexedFile(deps, 'old.md');
    deps.settings.mirrorDeletions = true;
    // Whether this becomes an upload or a move, the name check precedes mutations.
    vi.mocked(deps.drive.listFolder).mockResolvedValue(
      ok({
        ...emptyListing,
        dictionary: emptyDictionary(),
        dictionaryId: driveFileId('dict'),
        objectsFolderId: driveFileId('objects-id'),
        files: [old],
      }),
    );
    expect((await runPush(deps)).ok).toBe(false);
    expect(events).toEqual([]);
    expect(deps.drive.deleteFile).not.toHaveBeenCalled();
  });

  it('moves a file by renaming it without uploading content', async () => {
    const { deps, events } = setup('Data Structures/new.md');
    const old = await indexedFile(deps, 'old.md');
    vi.mocked(deps.drive.listFolder).mockResolvedValue(
      ok({
        ...emptyListing,
        dictionary: emptyDictionary(),
        dictionaryId: driveFileId('dict'),
        objectsFolderId: driveFileId('objects-id'),
        files: [old],
      }),
    );
    const result = await runPush(deps);
    expect(result.ok && result.value.moved).toBe(1);
    expect(events).toEqual(['dictionary', 'dictionary', 'rename']);
    expect(deps.drive.upload).not.toHaveBeenCalled();
    expect(deps.drive.updateContent).not.toHaveBeenCalled();
    expect(vi.mocked(deps.drive.renameFile).mock.calls[0]?.[0]).toBe('existing');
    expect(deps.drive.createObjectsFolder).not.toHaveBeenCalled();
  });

  it('does not upload a duplicate when new rules produce a different name for the same path', async () => {
    const { deps } = setup('Data Structures/note.md');
    const old = await indexedFile(deps, 'Data Structures/note.md');
    vi.mocked(deps.drive.listFolder).mockResolvedValue(
      ok({
        ...emptyListing,
        dictionary: emptyDictionary(),
        dictionaryId: driveFileId('dict'),
        objectsFolderId: driveFileId('objects-id'),
        files: [old],
      }),
    );
    const result = await runPush(deps);
    expect(result.ok && result.value.skipped).toBe(1);
    expect(deps.drive.upload).not.toHaveBeenCalled();
    expect(deps.drive.renameFile).not.toHaveBeenCalled();
  });
});
