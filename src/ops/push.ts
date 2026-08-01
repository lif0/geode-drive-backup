import { hashBytes, utf8Decode } from '../core/bytes';
import { encrypt, unlockVault } from '../core/container';
import { planPush } from '../core/diff';
import type { IgnoreRules } from '../core/ignore';
import { isIgnored, parseIgnore } from '../core/ignore';
import type { KeyCache } from '../core/kdf';
import { encodePath } from '../core/path-codec';
import type { DriveClient, GeodeAppProperties } from '../drive/client';
import type { GeodeSettings } from '../settings';
import type {
  Bytes,
  CancellationToken,
  CryptoProvider,
  DriveFileId,
  LocalFile,
  OperationSummary,
  ProgressReporter,
  PushAction,
  RemoteFile,
  Result,
  VaultIo,
  VaultPath,
} from '../types';
import { cancelledError, cryptoError, driveFileId, err, ok, vaultPath } from '../types';
import { listingWarnings, resolveFolder } from './folder';
import type { IndexStore } from './index-store';

/**
 * Push: upload locally changed files to Drive.
 *
 * Backup, not sync. It never merges, and it never overwrites a Drive file that
 * changed since this device last wrote it — those are reported as conflicts and
 * left alone.
 */

/** Everything push needs from the outside. */
export interface PushDeps {
  readonly vault: VaultIo;
  readonly drive: DriveClient;
  readonly crypto: CryptoProvider;
  readonly index: IndexStore;
  readonly keys: KeyCache;
  readonly progress: ProgressReporter;
  readonly settings: GeodeSettings;
  readonly cancellation: CancellationToken;
  /**
   * Asks the user for the passphrase. `isNewVault` is true when no `__keycheck`
   * exists yet, so the prompt can ask twice and warn that there is no recovery.
   * Resolves null if they cancel.
   */
  readonly requestPassphrase: (isNewVault: boolean) => Promise<string | null>;
  /** Caches the folder id in settings so the next run skips the lookup. */
  readonly rememberFolderId: (id: DriveFileId) => Promise<void>;
}

/**
 * How many files may be processed before the index is written again.
 *
 * The index used to be saved only at the very end. Quitting Obsidian mid-run
 * then left files on Drive with no index entry, and the next push reported every
 * one of them as a conflict. Saving as we go turns an interrupted run into one
 * that simply resumes.
 */
const INDEX_SAVE_EVERY = 25;

/**
 * Consecutive network failures before the run gives up on the rest.
 *
 * When the connection drops, the token is revoked or the Drive quota runs out,
 * every remaining file fails the same way. Grinding through two thousand of them
 * to report two thousand copies of one message helps nobody, and on a phone it
 * takes long enough that the user assumes the backup is working.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * How old a file's mtime must be before it may stand in for its contents.
 *
 * The mtime+size shortcut assumes a file that changes gets a new timestamp.
 * Filesystems with coarse clocks break that assumption: FAT32, which is what an
 * Android SD card usually is, rounds to two seconds. An edit that lands inside
 * the same tick and leaves the length alone is then invisible, and the stale
 * hash sticks forever — the one failure mode this plugin must not have.
 *
 * So a hash taken from a file whose timestamp is younger than one tick is
 * recorded as uncacheable, and the file is read once more on the next push.
 */
const MTIME_SETTLED_MS = 2000;

/** The vault's own ignore file. Only the one at the root is read. */
const GITIGNORE_PATH = '.gitignore';

interface Counters {
  uploaded: number;
  updated: number;
  deleted: number;
  skipped: number;
}

function properties(encrypted: boolean): GeodeAppProperties {
  return { v: '1', enc: encrypted ? '1' : '0' };
}

/** `mtime` if it is old enough to be evidence, else `-1`: "always re-read". */
function cacheableMtime(mtime: number, now: number): number {
  return now - mtime >= MTIME_SETTLED_MS ? mtime : -1;
}

/**
 * Builds the exclusion rules for this run: the vault's `.gitignore`, then the
 * lines from settings.
 *
 * Settings come second so a `!` there can bring back something the repository's
 * own ignore file excluded — the vault is a repository first and a backup
 * second, and the two do not always want the same files.
 */
export async function loadIgnoreRules(deps: {
  readonly vault: VaultIo;
  readonly settings: GeodeSettings;
}): Promise<IgnoreRules> {
  const sources: string[] = [];

  if (deps.settings.useGitignore) {
    const path = vaultPath(GITIGNORE_PATH);
    try {
      if (await deps.vault.exists(path)) {
        sources.push(utf8Decode(await deps.vault.readBinary(path)));
      }
    } catch {
      // An unreadable .gitignore excludes nothing. Failing the push over it
      // would trade a backup that holds a few unwanted files for no backup.
    }
  }

  sources.push(deps.settings.excludedPaths.join('\n'));
  return parseIgnore(sources.join('\n'));
}

/**
 * Reads and hashes every local file. The hash is always of the plaintext.
 *
 * A file whose mtime AND size both still match the index keeps its recorded
 * hash and is never opened. On a vault where little changed between pushes this
 * turns "read every byte you own" into "stat every file", which is the
 * difference between minutes and a moment.
 *
 * Staleness is still decided ONLY by comparing sha256 against the index. mtime
 * is never evidence that a file changed — only that it might have.
 *
 * Excluded files are dropped before any of that. Not opening them is most of
 * the point: the folders people exclude are the big ones, and hashing a few
 * gigabytes of video on every push to then decide against uploading it is the
 * cost the exclusion was meant to remove.
 */
async function collectLocalFiles(
  deps: PushDeps,
  ignore: IgnoreRules,
): Promise<Result<{ files: LocalFile[]; excluded: number }>> {
  const all = await deps.vault.listFiles();
  const stats = all.filter((stat) => !isIgnored(ignore, stat.path));
  const excluded = all.length - stats.length;
  const files: LocalFile[] = [];
  let hashed = 0;

  // No byte total: this phase reads and hashes rather than transferring, and a
  // byte bar here would be measuring the wrong thing.
  deps.progress.begin('Reading vault', stats.length, 0);
  for (const stat of stats) {
    if (deps.cancellation.isCancelled()) {
      return err(cancelledError('Cancelled while reading the vault.'));
    }

    const known = deps.index.get(stat.path);
    if (known?.mtime === stat.mtime && known.size === stat.size) {
      files.push({ path: stat.path, sha256: known.sha256, mtime: stat.mtime, size: stat.size });
      deps.progress.advance(stat.path);
      continue;
    }

    try {
      const bytes = await deps.vault.readBinary(stat.path);
      files.push({
        path: stat.path,
        sha256: await hashBytes(deps.crypto, bytes),
        mtime: cacheableMtime(stat.mtime, Date.now()),
        size: stat.size,
      });
      hashed += 1;
    } catch (cause) {
      return err(cryptoError(`Could not read ${stat.path}.`, cause));
    }
    deps.progress.advance(stat.path);
  }

  const note = `hashed ${String(hashed)} of ${String(stats.length)} files`;
  deps.progress.note(excluded > 0 ? `${note}, ${String(excluded)} excluded` : note);
  return ok({ files, excluded });
}

/**
 * Unlocks encryption if the plan needs it.
 *
 * Runs before any upload. A wrong passphrase aborts the whole push with nothing
 * written, locally or remotely.
 */
async function unlockIfNeeded(
  deps: PushDeps,
  folderId: DriveFileId,
  keycheckId: DriveFileId | null,
  needed: boolean,
): Promise<Result<Bytes | null>> {
  if (!needed) return ok(null);

  if (deps.keys.isUnlocked() && deps.settings.passphrasePrompt === 'once-per-session') {
    const salt = deps.keys.getSalt();
    if (salt !== null) return ok(salt);
  }

  let existing: Bytes | null = null;
  if (keycheckId !== null) {
    const downloaded = await deps.drive.download(keycheckId);
    if (!downloaded.ok) return downloaded;
    existing = downloaded.value;
  }

  const passphrase = await deps.requestPassphrase(existing === null);
  if (passphrase === null) return err(cancelledError('Push cancelled: no passphrase.'));

  const unlocked = await unlockVault(deps.crypto, deps.keys, existing, passphrase);
  if (!unlocked.ok) return unlocked;

  if (unlocked.value.keycheckToUpload !== null) {
    const stored = await deps.drive.putKeycheck(
      folderId,
      keycheckId,
      unlocked.value.keycheckToUpload,
    );
    if (!stored.ok) return stored;
  }

  return ok(unlocked.value.salt);
}

/** Encrypts if the action asks for it, otherwise passes the bytes through. */
async function contentFor(
  deps: PushDeps,
  plaintext: Bytes,
  shouldEncrypt: boolean,
  salt: Bytes | null,
): Promise<Result<Bytes>> {
  if (!shouldEncrypt) return ok(plaintext);

  const key = deps.keys.getKey();
  if (key === null || salt === null) {
    return err(cryptoError('Encryption is on but the vault is locked.'));
  }
  return encrypt(deps.crypto, key, salt, plaintext);
}

/** Runs a push and reports what it did. */
export async function runPush(deps: PushDeps): Promise<Result<OperationSummary>> {
  const folderId = await resolveFolder(deps);
  if (!folderId.ok) return folderId;

  const listing = await deps.drive.listFolder(folderId.value);
  if (!listing.ok) return listing;

  const ignore = await loadIgnoreRules(deps);

  const collected = await collectLocalFiles(deps, ignore);
  if (!collected.ok) return collected;
  const localFiles = collected.value.files;

  const plan = planPush(localFiles, deps.index.snapshot(), listing.value.files, {
    encryptionEnabled: deps.settings.encryptionEnabled,
    encryptedPrefixes: deps.settings.encryptedPrefixes,
    mirrorDeletions: deps.settings.mirrorDeletions,
    ignore,
  });

  const needsKey = plan.actions.some(
    (action) => (action.type === 'upload' || action.type === 'update') && action.encrypt,
  );
  const salt = await unlockIfNeeded(deps, folderId.value, listing.value.keycheckId, needsKey);
  if (!salt.ok) return salt;

  const localByPath = new Map<string, LocalFile>(localFiles.map((f) => [f.path, f]));
  const remoteByPath = new Map<string, RemoteFile>(listing.value.files.map((f) => [f.path, f]));

  const counters: Counters = { uploaded: 0, updated: 0, deleted: 0, skipped: 0 };
  const conflicts: VaultPath[] = [];
  const failures: { path: VaultPath; message: string }[] = [];
  const warnings = listingWarnings(listing.value);

  // Every byte this run will move is known before the first one does, because
  // the plan says which files go and the vault says how big they are. That is
  // what makes the overall bar honest rather than a file counter in disguise.
  const work = plan.actions.filter((action) => action.type !== 'skip');
  const workBytes = work.reduce(
    (total, action) =>
      action.type === 'upload' || action.type === 'update'
        ? total + (localByPath.get(action.path)?.size ?? 0)
        : total,
    0,
  );
  deps.progress.begin('Pushing', work.length, workBytes);

  let cancelled = false;
  let sinceSave = 0;
  let consecutiveFailures = 0;

  for (const action of plan.actions) {
    if (deps.cancellation.isCancelled()) {
      cancelled = true;
      break;
    }

    const outcome = await applyAction(deps, action, {
      folderId: folderId.value,
      salt: salt.value,
      localByPath,
      remoteByPath,
      counters,
      conflicts,
    });
    if (outcome.ok) {
      consecutiveFailures = 0;
    } else {
      failures.push({ path: action.path, message: outcome.error.message });
      // Only transport and credential failures count towards giving up. A file
      // that could not be read or encrypted says nothing about the next one.
      const systemic = outcome.error.kind === 'network' || outcome.error.kind === 'auth';
      consecutiveFailures = systemic ? consecutiveFailures + 1 : 0;
    }

    if (action.type !== 'skip') {
      deps.progress.advance(action.path);
      sinceSave += 1;
      if (sinceSave >= INDEX_SAVE_EVERY) {
        await deps.index.save();
        sinceSave = 0;
      }
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      warnings.push(
        `Stopped early: ${String(consecutiveFailures)} files in a row failed the same way. ` +
          'Everything already uploaded is recorded — run the push again once the problem is fixed.',
      );
      break;
    }
  }

  // Paths that are gone from the vault and from Drive. Dropping them keeps
  // data.json from growing forever and the tracked-file count honest.
  for (const path of plan.forget) deps.index.remove(path);

  await deps.index.save();

  return ok({
    operation: 'push',
    cancelled,
    uploaded: counters.uploaded,
    updated: counters.updated,
    downloaded: 0,
    renamed: 0,
    deleted: counters.deleted,
    skipped: counters.skipped,
    excluded: collected.value.excluded,
    conflicts,
    failures,
    warnings,
  });
}

interface ActionContext {
  readonly folderId: DriveFileId;
  readonly salt: Bytes | null;
  readonly localByPath: ReadonlyMap<string, LocalFile>;
  readonly remoteByPath: ReadonlyMap<string, RemoteFile>;
  readonly counters: Counters;
  readonly conflicts: VaultPath[];
}

async function applyAction(
  deps: PushDeps,
  action: PushAction,
  context: ActionContext,
): Promise<Result<void>> {
  switch (action.type) {
    case 'skip': {
      context.counters.skipped += 1;
      return ok(undefined);
    }

    case 'conflict': {
      context.conflicts.push(action.path);
      return ok(undefined);
    }

    case 'delete-remote': {
      const deleted = await deps.drive.deleteFile(action.fileId);
      if (!deleted.ok) return deleted;
      deps.index.remove(action.path);
      context.counters.deleted += 1;
      return ok(undefined);
    }

    case 'upload':
    case 'update': {
      const file = context.localByPath.get(action.path);
      if (file === undefined) return ok(undefined);

      const plaintext = await deps.vault.readBinary(action.path);
      const content = await contentFor(deps, plaintext, action.encrypt, context.salt);
      if (!content.ok) return content;

      // Report the size actually going over the wire, not the planned one, so
      // the per-file bar ends exactly where the transfer does. The plan counted
      // plaintext and a container is 49 bytes longer, so on a vault of encrypted
      // files the overall bar finishes a few kilobytes past its own total. It is
      // clamped at 100%, and the alternative — a bar that stops just short — is
      // the more alarming of the two.
      deps.progress.beginFile(action.path, content.value.length);
      const onProgress = (bytes: number): void => {
        deps.progress.fileProgress(bytes);
      };

      if (action.type === 'upload') {
        const uploaded = await deps.drive.upload(
          context.folderId,
          encodePath(action.path),
          content.value,
          properties(action.encrypt),
          onProgress,
        );
        if (!uploaded.ok) return uploaded;

        deps.index.set(action.path, {
          sha256: file.sha256,
          driveFileId: driveFileId(uploaded.value.id),
          remoteMd5: uploaded.value.md5Checksum ?? '',
          mtime: file.mtime,
          size: file.size,
        });
        context.counters.uploaded += 1;
        return ok(undefined);
      }

      const updated = await deps.drive.updateContent(action.fileId, content.value, onProgress);
      if (!updated.ok) return updated;

      // The appProperties flag is advisory, but leaving it stale is misleading.
      // Only patch when it actually changed, to save a request per file.
      const remote = context.remoteByPath.get(action.path);
      if (remote !== undefined && remote.encryptedFlag !== action.encrypt) {
        const patched = await deps.drive.updateAppProperties(
          action.fileId,
          properties(action.encrypt),
        );
        if (!patched.ok) return patched;
      }

      deps.index.set(action.path, {
        sha256: file.sha256,
        driveFileId: action.fileId,
        remoteMd5: updated.value.md5Checksum ?? '',
        mtime: file.mtime,
        size: file.size,
      });
      context.counters.updated += 1;
      return ok(undefined);
    }
  }
}
