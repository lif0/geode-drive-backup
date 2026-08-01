import { hashBytes } from '../core/bytes';
import { decrypt, isContainer, unlockVault } from '../core/container';
import { planPull } from '../core/diff';
import type { KeyCache } from '../core/kdf';
import type { DriveClient } from '../drive/client';
import type { GeodeSettings } from '../settings';
import type {
  Bytes,
  CancellationToken,
  CryptoProvider,
  DriveFileId,
  LocalFile,
  OperationSummary,
  ProgressReporter,
  PullAction,
  RemoteFile,
  Result,
  VaultIo,
  VaultPath,
} from '../types';
import { cancelledError, cryptoError, err, ok } from '../types';
import { listingWarnings, resolveFolder } from './folder';
import type { IndexStore } from './index-store';

/**
 * Pull: rebuild the vault from Drive.
 *
 * Never deletes and never overwrites. A local file that differs from the Drive
 * copy stays where it is and the incoming file lands beside it as
 * `<name> (from drive).<ext>`.
 */

/** Everything pull needs from the outside. */
export interface PullDeps {
  readonly vault: VaultIo;
  readonly drive: DriveClient;
  readonly crypto: CryptoProvider;
  readonly index: IndexStore;
  readonly keys: KeyCache;
  readonly progress: ProgressReporter;
  readonly settings: GeodeSettings;
  readonly cancellation: CancellationToken;
  /**
   * Asks the user for the passphrase. Always called with false: a pull only
   * needs a passphrase when the vault already has a `__keycheck`.
   */
  readonly requestPassphrase: (isNewVault: boolean) => Promise<string | null>;
  readonly rememberFolderId: (id: DriveFileId) => Promise<void>;
}

/** Files processed between index writes, so an interrupted pull resumes. */
const INDEX_SAVE_EVERY = 25;

/** As in push: stop grinding once every file is failing for the same reason. */
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Hashes what is already in the vault, so the planner can tell "same file" from
 * "different file with the same name".
 *
 * Every file is read, with no mtime+size shortcut. Push takes that shortcut and
 * is right to: the cost of being wrong there is a missed upload, which the next
 * push fixes. Pull is the operation people run when something has already gone
 * wrong, and the cost of being wrong here is deciding a local file matches the
 * backup and declining to bring the backup down beside it. On a vault this slow
 * to hash the user can now press Cancel, which is what the check below is for —
 * this phase used to ignore cancellation until it was over.
 */
async function collectLocalFiles(deps: PullDeps): Promise<Result<LocalFile[]>> {
  const stats = await deps.vault.listFiles();
  const files: LocalFile[] = [];

  deps.progress.begin('Reading vault', stats.length);
  for (const stat of stats) {
    if (deps.cancellation.isCancelled()) {
      return err(cancelledError('Cancelled while reading the vault.'));
    }

    try {
      const bytes = await deps.vault.readBinary(stat.path);
      files.push({
        path: stat.path,
        sha256: await hashBytes(deps.crypto, bytes),
        mtime: stat.mtime,
        size: stat.size,
      });
    } catch {
      // An unreadable local file just means the planner treats its path as
      // occupied, which is the safe answer: the download lands beside it.
      files.push({
        path: stat.path,
        sha256: await hashBytes(deps.crypto, new Uint8Array(0)),
        mtime: stat.mtime,
        size: stat.size,
      });
    }
    deps.progress.advance(stat.path);
  }

  return ok(files);
}

/**
 * Validates the passphrase against `__keycheck` before a single byte is written.
 *
 * This is the whole point of the keycheck file: a new device finds out the
 * passphrase is wrong here, not after scattering undecryptable files across the
 * vault.
 */
async function unlockIfNeeded(
  deps: PullDeps,
  keycheckId: DriveFileId | null,
): Promise<Result<boolean>> {
  if (keycheckId === null) {
    // No keycheck: either nothing was ever encrypted, or the file was deleted.
    // Downloads that turn out to be containers will fail individually and be
    // reported, rather than blocking the whole pull.
    return ok(false);
  }

  if (deps.keys.isUnlocked() && deps.settings.passphrasePrompt === 'once-per-session') {
    return ok(true);
  }

  const downloaded = await deps.drive.download(keycheckId);
  if (!downloaded.ok) return downloaded;

  const passphrase = await deps.requestPassphrase(false);
  if (passphrase === null) return err(cancelledError('Pull cancelled: no passphrase.'));

  const unlocked = await unlockVault(deps.crypto, deps.keys, downloaded.value, passphrase);
  if (!unlocked.ok) return unlocked;

  return ok(true);
}

/**
 * Decrypts if the bytes carry the container magic.
 *
 * The MAGIC header decides, not the file extension and not the `enc`
 * appProperty — both of those drift when a file is re-uploaded by an older
 * build or edited in the Drive web UI.
 */
async function plaintextOf(deps: PullDeps, bytes: Bytes): Promise<Result<Bytes>> {
  if (!isContainer(bytes)) return ok(bytes);

  const key = deps.keys.getKey();
  if (key === null) {
    return err(cryptoError('This file is encrypted and the vault is locked.'));
  }
  return decrypt(deps.crypto, key, bytes);
}

/** Runs a pull and reports what it did. */
export async function runPull(deps: PullDeps): Promise<Result<OperationSummary>> {
  const folderId = await resolveFolder(deps);
  if (!folderId.ok) return folderId;

  const listing = await deps.drive.listFolder(folderId.value);
  if (!listing.ok) return listing;

  const unlocked = await unlockIfNeeded(deps, listing.value.keycheckId);
  if (!unlocked.ok) return unlocked;

  const localFiles = await collectLocalFiles(deps);
  if (!localFiles.ok) return localFiles;

  const plan = planPull(listing.value.files, localFiles.value, deps.index.snapshot());

  const remoteByPath = new Map<string, RemoteFile>(listing.value.files.map((f) => [f.path, f]));

  let downloaded = 0;
  let renamed = 0;
  let skipped = 0;
  const failures: { path: VaultPath; message: string }[] = [];
  const warnings = listingWarnings(listing.value);

  const work = plan.actions.filter((action) => action.type !== 'skip');
  deps.progress.begin('Pulling', work.length);

  let cancelled = deps.cancellation.isCancelled();
  let sinceSave = 0;
  let consecutiveFailures = 0;

  for (const action of plan.actions) {
    if (action.type === 'skip') {
      skipped += 1;
      continue;
    }
    if (deps.cancellation.isCancelled()) {
      cancelled = true;
      break;
    }

    const outcome = await writeIncoming(deps, action, remoteByPath);
    if (outcome.ok) {
      if (action.type === 'download') downloaded += 1;
      else renamed += 1;
      consecutiveFailures = 0;
    } else {
      failures.push({ path: action.path, message: outcome.error.message });
      const systemic = outcome.error.kind === 'network' || outcome.error.kind === 'auth';
      consecutiveFailures = systemic ? consecutiveFailures + 1 : 0;
    }
    deps.progress.advance(action.writeTo);

    sinceSave += 1;
    if (sinceSave >= INDEX_SAVE_EVERY) {
      await deps.index.save();
      sinceSave = 0;
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      warnings.push(
        `Stopped early: ${String(consecutiveFailures)} files in a row failed the same way. ` +
          'Everything already downloaded is on disk — run the pull again once the problem is fixed.',
      );
      break;
    }
  }

  await deps.index.save();

  return ok({
    operation: 'pull',
    cancelled,
    uploaded: 0,
    updated: 0,
    downloaded,
    renamed,
    deleted: 0,
    skipped,
    // Exclusions govern what leaves the device, not what comes back to it. A
    // path you stopped uploading is still one you must be able to restore.
    excluded: 0,
    conflicts: [],
    failures,
    warnings,
  });
}

async function writeIncoming(
  deps: PullDeps,
  action: Extract<PullAction, { type: 'download' | 'rename-on-collision' }>,
  remoteByPath: ReadonlyMap<string, RemoteFile>,
): Promise<Result<void>> {
  const bytes = await deps.drive.download(action.fileId);
  if (!bytes.ok) return bytes;

  const plaintext = await plaintextOf(deps, bytes.value);
  if (!plaintext.ok) return plaintext;

  try {
    await deps.vault.ensureParentFolder(action.writeTo);
    await deps.vault.writeBinary(action.writeTo, plaintext.value);
  } catch (cause) {
    return err(cryptoError(`Could not write ${action.writeTo}.`, cause));
  }

  // Only a file written at its own path is the file Drive holds. A renamed copy
  // is a second file that this device has never pushed, so indexing it would
  // claim Drive already has it.
  if (action.type === 'download') {
    const remote = remoteByPath.get(action.path);
    deps.index.set(action.path, {
      sha256: await hashBytes(deps.crypto, plaintext.value),
      driveFileId: action.fileId,
      remoteMd5: remote?.md5 ?? '',
      // The file was just written, so its mtime is now and its size is known.
      // Both feed the hash cache on the next push.
      mtime: Date.now(),
      size: plaintext.value.length,
    });
  }

  return ok(undefined);
}
