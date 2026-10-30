import { utf8Encode } from '../core/bytes';
import type { PathDictionary } from '../core/path-dictionary';
import {
  emptyDictionary,
  MAX_DICTIONARY_BYTES,
  mergeDictionaries,
  readDictionary,
  serializeDictionary,
} from '../core/path-dictionary';
import type { DriveClient, FolderListing } from '../drive/client';
import type { GeodeSettings } from '../settings';
import type { DriveFileId, Result } from '../types';
import { err, ioError, ok } from '../types';

export interface DictionaryDeps {
  readonly settings: GeodeSettings;
  readonly drive: Pick<DriveClient, 'writeDictionary'>;
  readonly rememberDictionary: (dictionary: PathDictionary, folderId: DriveFileId) => Promise<void>;
}

/** A fresh, validated snapshot. Later edits to settings cannot affect this run. */
export function dictionaryFor(
  settings: GeodeSettings,
  folderId: DriveFileId,
  listing: FolderListing,
): Result<PathDictionary> {
  if (settings.pathDictionaryError !== null) return err(ioError(settings.pathDictionaryError));
  if (listing.dictionary === null && settings.dictionaryFolderId === folderId) {
    return err(
      ioError('The previously published path dictionary is missing. Restore it before continuing.'),
    );
  }
  const local = readDictionary(settings.pathDictionary);
  if (!local.ok) return local;
  return mergeDictionaries(local.value, listing.dictionary ?? emptyDictionary());
}

/** Single-writer protocol: preserve old dictionary, publish new dictionary, then files. */
export async function publishDictionary(
  deps: DictionaryDeps,
  folderId: DriveFileId,
  listing: FolderListing,
  dictionary: PathDictionary,
): Promise<Result<void>> {
  const serialized = serializeDictionary(dictionary);
  const content = utf8Encode(serialized);
  if (content.length > MAX_DICTIONARY_BYTES) return err(ioError('Path dictionary is too large.'));
  if (listing.dictionary === null || serializeDictionary(listing.dictionary) !== serialized) {
    if (listing.dictionary !== null) {
      const backup = await deps.drive.writeDictionary(
        folderId,
        listing.dictionaryBackupId,
        utf8Encode(serializeDictionary(listing.dictionary)),
        true,
      );
      if (!backup.ok) return backup;
    }
    const saved = await deps.drive.writeDictionary(folderId, listing.dictionaryId, content, false);
    if (!saved.ok) return saved;
  }
  await deps.rememberDictionary(dictionary, folderId);
  return ok(undefined);
}
