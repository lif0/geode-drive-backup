import { hashBytes } from '../core/bytes';
import { decrypt, isContainer, unlockVault } from '../core/container';
import { planPull } from '../core/diff';
import type { KeyCache } from '../core/kdf';
import type { DriveClient } from '../drive/client';
import type { GeodeSettings } from '../settings';
import type {
  Bytes,
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
import { cancelledError, cryptoError, driveFileId, err, ok } from '../types';
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
  /**
   * Asks the user for the passphrase. Always called with false: a pull only
   * needs a passphrase when the vault already has a `__keycheck`.
   */
  readonly requestPassphrase: (isNewVault: boolean) => Promise<string | null>;
  readonly rememberFolderId: (id: DriveFileId) => Promise<void>;
}

async function resolveFolder(deps: PullDeps): Promise<Result<DriveFileId>> {
  const cached = deps.settings.folderId;
  if (cached !== null && cached.length > 0) return ok(driveFileId(cached));

  const ensured = await deps.drive.ensureFolder(deps.settings.folderName);
  if (!ensured.ok) return ensured;

  await deps.rememberFolderId(ensured.value);
  return ensured;
}

/**
 * Hashes what is already in the vault, so the planner can tell "same file" from
 * "different file with the same name".
 */
async function collectLocalFiles(deps: PullDeps): Promise<LocalFile[]> {
  const stats = await deps.vault.listFiles();
  const files: LocalFile[] = [];

  deps.progress.begin('Reading vault', stats.length);
  for (const stat of stats) {
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

  return files;
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
  const plan = planPull(listing.value.files, localFiles, deps.index.snapshot());

  const remoteByPath = new Map<string, RemoteFile>(listing.value.files.map((f) => [f.path, f]));

  let downloaded = 0;
  let renamed = 0;
  let skipped = 0;
  const failures: { path: VaultPath; message: string }[] = [];

  const work = plan.actions.filter((action) => action.type !== 'skip');
  deps.progress.begin('Pulling', work.length);

  for (const action of plan.actions) {
    if (action.type === 'skip') {
      skipped += 1;
      continue;
    }

    const outcome = await writeIncoming(deps, action, remoteByPath);
    if (outcome.ok) {
      if (action.type === 'download') downloaded += 1;
      else renamed += 1;
    } else {
      failures.push({ path: action.path, message: outcome.error.message });
    }
    deps.progress.advance(action.writeTo);
  }

  await deps.index.save();

  return ok({
    operation: 'pull',
    uploaded: 0,
    updated: 0,
    downloaded,
    renamed,
    deleted: 0,
    skipped,
    conflicts: [],
    failures,
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
      mtime: Date.now(),
    });
  }

  return ok(undefined);
}
