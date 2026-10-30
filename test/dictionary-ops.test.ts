import { describe, expect, it, vi } from 'vitest';
import type { FolderListing } from '../src/drive/client';
import type { PathDictionary } from '../src/core/path-dictionary';
import { emptyDictionary } from '../src/core/path-dictionary';
import { dictionaryFor, publishDictionary } from '../src/ops/path-dictionary';
import type { DictionaryDeps } from '../src/ops/path-dictionary';
import { defaultSettings } from '../src/settings';
import { driveFileId, err, ioError, ok } from '../src/types';

const folder = driveFileId('folder');
const next: PathDictionary = { version: 1, rules: [{ id: 1, text: 'Data', enabled: true }] };
const listing: FolderListing = {
  files: [],
  keycheckId: null,
  ignored: [],
  duplicates: [],
  dictionary: null,
  dictionaryId: null,
  dictionaryBackupId: null,
  objectsFolderId: null,
};

function deps(): DictionaryDeps {
  return {
    settings: defaultSettings(),
    drive: { writeDictionary: vi.fn().mockResolvedValue(ok(driveFileId('dictionary'))) },
    rememberDictionary: vi.fn().mockResolvedValue(undefined),
  };
}

describe('dictionary publication', () => {
  it('creates the dictionary before remembering it locally', async () => {
    const events: string[] = [];
    const dependencies = deps();
    vi.mocked(dependencies.drive.writeDictionary).mockImplementation(() => {
      events.push('remote');
      return Promise.resolve(ok(driveFileId('dict')));
    });
    vi.mocked(dependencies.rememberDictionary).mockImplementation(() => {
      events.push('local');
      return Promise.resolve();
    });
    expect((await publishDictionary(dependencies, folder, listing, next)).ok).toBe(true);
    expect(events).toEqual(['remote', 'local']);
  });

  it('saves the previous dictionary before replacing the current one', async () => {
    const dependencies = deps();
    const old = { ...listing, dictionary: emptyDictionary(), dictionaryId: driveFileId('dict') };
    expect((await publishDictionary(dependencies, folder, old, next)).ok).toBe(true);
    const calls = vi.mocked(dependencies.drive.writeDictionary).mock.calls;
    expect(calls.map((call) => call[3])).toEqual([true, false]);
    expect(new TextDecoder().decode(calls[0]?.[2])).toContain('"rules": []');
    expect(new TextDecoder().decode(calls[1]?.[2])).toContain('Data');
  });

  it('does not rewrite an unchanged dictionary', async () => {
    const dependencies = deps();
    await publishDictionary(
      dependencies,
      folder,
      { ...listing, dictionary: next, dictionaryId: driveFileId('dict') },
      next,
    );
    expect(dependencies.drive.writeDictionary).not.toHaveBeenCalled();
    expect(dependencies.rememberDictionary).toHaveBeenCalledWith(next, folder);
  });

  it('stops on backup failure without touching the current dictionary', async () => {
    const dependencies = deps();
    vi.mocked(dependencies.drive.writeDictionary).mockResolvedValue(err(ioError('offline')));
    const result = await publishDictionary(
      dependencies,
      folder,
      { ...listing, dictionary: emptyDictionary(), dictionaryId: driveFileId('dict') },
      next,
    );
    expect(result.ok).toBe(false);
    expect(dependencies.drive.writeDictionary).toHaveBeenCalledTimes(1);
    expect(dependencies.rememberDictionary).not.toHaveBeenCalled();
  });

  it('does not record local success when publishing fails after a backup', async () => {
    const dependencies = deps();
    vi.mocked(dependencies.drive.writeDictionary)
      .mockResolvedValueOnce(ok(driveFileId('backup')))
      .mockResolvedValueOnce(err(ioError('quota')));
    expect(
      (
        await publishDictionary(
          dependencies,
          folder,
          { ...listing, dictionary: emptyDictionary(), dictionaryId: driveFileId('dict') },
          next,
        )
      ).ok,
    ).toBe(false);
    expect(dependencies.rememberDictionary).not.toHaveBeenCalled();
  });

  it('refuses to initialize a missing dictionary in a known folder', () => {
    const settings = defaultSettings();
    settings.dictionaryFolderId = folder;
    expect(dictionaryFor(settings, folder, listing).ok).toBe(false);
    expect(dictionaryFor(settings, driveFileId('new-folder'), listing).ok).toBe(true);
  });

  it('imports remote rules into a fresh local snapshot', () => {
    const settings = defaultSettings();
    expect(dictionaryFor(settings, folder, { ...listing, dictionary: next })).toEqual(ok(next));
    expect(settings.pathDictionary.rules).toHaveLength(0);
  });
});
