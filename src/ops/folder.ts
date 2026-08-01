import type { DriveClient, FolderListing } from '../drive/client';
import type { GeodeSettings } from '../settings';
import type { DriveFileId, Result } from '../types';
import { driveFileId, ok } from '../types';

/**
 * Finding the Drive folder, and reading what the listing implies.
 *
 * Shared because push and pull need exactly the same two things and getting
 * either of them subtly wrong in one of the two is how a backup goes quiet.
 */

/** The slice of PushDeps/PullDeps this module needs. */
export interface FolderDeps {
  readonly drive: DriveClient;
  readonly settings: GeodeSettings;
  readonly rememberFolderId: (id: DriveFileId) => Promise<void>;
}

/**
 * Resolves the Drive folder, preferring the cached id but never trusting it.
 *
 * The cached id is checked because the way it goes bad is silent. Trash the
 * folder, or connect a different Google account, and listing it still succeeds
 * — it just comes back empty. Push then concludes that Drive has lost the whole
 * vault, plans to upload every file again, and fails on each one because the
 * parent it names is not there. A single check turns that into a folder lookup
 * by name, which is what the user meant.
 *
 * A failure to answer the question is not an answer: if the check itself errors,
 * the error is returned rather than treated as "missing". Otherwise one flaky
 * request would strand the backup in a second, empty folder.
 */
export async function resolveFolder(deps: FolderDeps): Promise<Result<DriveFileId>> {
  const cached = deps.settings.folderId;
  if (cached !== null && cached.length > 0) {
    const id = driveFileId(cached);
    const usable = await deps.drive.folderIsUsable(id);
    if (!usable.ok) return usable;
    if (usable.value) return ok(id);
  }

  const ensured = await deps.drive.ensureFolder(deps.settings.folderName);
  if (!ensured.ok) return ensured;

  await deps.rememberFolderId(ensured.value);
  return ensured;
}

/** Shows the first few paths of a list, and says how many were left out. */
function preview(paths: readonly string[], limit = 3): string {
  const shown = paths.slice(0, limit).join(', ');
  return paths.length > limit ? `${shown} and ${String(paths.length - limit)} more` : shown;
}

/**
 * What a folder listing says that the file counters cannot.
 *
 * Both cases are silent by nature — the run succeeds and the numbers look
 * right — and both mean a file the user believes is backed up is not the file
 * Geode is working with.
 */
export function listingWarnings(listing: FolderListing): string[] {
  const warnings: string[] = [];

  if (listing.duplicates.length > 0) {
    warnings.push(
      `${String(listing.duplicates.length)} path(s) have more than one copy on Drive. ` +
        `Geode uses the newest and ignores the rest: ${preview(listing.duplicates)}`,
    );
  }

  if (listing.ignored.length > 0) {
    warnings.push(
      `${String(listing.ignored.length)} file(s) in the Drive folder were not written by Geode ` +
        `and are not part of the backup: ${preview(listing.ignored)}`,
    );
  }

  return warnings;
}
