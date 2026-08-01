import type {
  DriveFileId,
  IndexEntry,
  LocalFile,
  LocalIndex,
  PullAction,
  PullPlan,
  PushAction,
  PushPlan,
  RemoteFile,
  VaultPath,
} from '../types';
import { vaultPath } from '../types';
import type { IgnoreRules } from './ignore';
import { isIgnored } from './ignore';
import { shouldEncrypt } from './selector';

/**
 * Staleness decisions. Pure: no network, no disk, no clock.
 *
 * The one rule that matters: a file is stale when its PLAINTEXT sha256 differs
 * from the one in the index. Ciphertext changes on every push because the nonce
 * is fresh, so comparing ciphertext or remote md5 to answer "did this change"
 * re-uploads the whole vault every time.
 *
 * Remote md5 is used for one thing only — noticing that another device wrote the
 * file since we last did.
 */

/** Inputs that steer a push, taken from settings. */
export interface PushOptions {
  readonly encryptionEnabled: boolean;
  readonly encryptedPrefixes: readonly string[];
  /** Off by default. On, a file deleted locally is deleted from Drive too. */
  readonly mirrorDeletions: boolean;
  /** Paths that are not part of the backup at all. See `core/ignore`. */
  readonly ignore: IgnoreRules;
}

/**
 * True when Drive's md5 proves another device rewrote the file.
 *
 * Returns false when either md5 is missing: Drive omits md5Checksum for some
 * files, and an unknown answer must not be reported as a conflict.
 */
function remoteWasRewritten(indexedMd5: string, remoteMd5: string): boolean {
  if (indexedMd5.length === 0 || remoteMd5.length === 0) return false;
  return indexedMd5 !== remoteMd5;
}

/**
 * Orders paths by UTF-16 code unit.
 *
 * Deliberately not `localeCompare`: that sorts by the device's collation rules,
 * so the same vault would produce a different plan on a different phone.
 */
function comparePaths(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function byPath<T extends { readonly path: VaultPath }>(items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(item.path, item);
  return map;
}

/**
 * The form of a path used to answer "is this name already taken?".
 *
 * Drive is case-sensitive and stores whatever byte string it was handed. Most
 * of the filesystems a vault lives on are not: APFS, NTFS and the exFAT of an
 * Android SD card all treat `Note.md` and `note.md` as one file. Comparing
 * exactly would let a pull write `note.md` on top of a local `Note.md` — an
 * overwrite, which pull is not allowed to do.
 *
 * So occupancy is decided case-insensitively everywhere, including on a
 * genuinely case-sensitive filesystem. The cost there is a needless
 * `(from drive)` copy for two files that differ only in case; the cost of
 * guessing wrong the other way is a destroyed note.
 */
export function foldPath(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/**
 * A Drive file whose vault path is gone, and which could therefore be the file
 * that turned up somewhere else under a new name.
 */
interface MoveCandidate {
  readonly path: VaultPath;
  readonly entry: IndexEntry;
  readonly fileId: DriveFileId;
  /** What Drive says the bytes are: a container, or the plaintext. */
  readonly encryptedFlag: boolean;
  /** Whether the rule at the OLD path asked for encryption. */
  readonly wasEncrypted: boolean;
}

/**
 * Indexes, by content hash, every file that vanished from the vault but is still
 * on Drive intact.
 *
 * These are the only files a move may be built from. Three conditions, and each
 * one is load-bearing:
 *
 * - the path is gone from the vault, so a file that was COPIED rather than moved
 *   is never a candidate and its Drive copy is never touched;
 * - Drive still holds it, so there is something to rename;
 * - the md5 still matches the index, so a file another device rewrote keeps its
 *   ordinary conflict handling instead of being quietly renamed away.
 *
 * Excluded paths are left out: a file that an ignore rule now covers is not
 * missing, and its Drive copy is not the plugin's to move.
 */
function moveCandidates(
  index: LocalIndex,
  localPaths: ReadonlySet<string>,
  remoteByPath: ReadonlyMap<string, RemoteFile>,
  options: PushOptions,
): Map<string, MoveCandidate[]> {
  const byHash = new Map<string, MoveCandidate[]>();

  for (const path of Object.keys(index).sort(comparePaths)) {
    if (localPaths.has(path)) continue;

    const typedPath = vaultPath(path);
    if (isIgnored(options.ignore, typedPath)) continue;

    const entry = index[typedPath];
    const remoteFile = remoteByPath.get(path);
    if (entry === undefined || remoteFile === undefined) continue;
    if (remoteWasRewritten(entry.remoteMd5, remoteFile.md5)) continue;

    const candidates = byHash.get(entry.sha256) ?? [];
    candidates.push({
      path: typedPath,
      entry,
      fileId: remoteFile.id,
      encryptedFlag: remoteFile.encryptedFlag,
      wasEncrypted:
        options.encryptionEnabled && shouldEncrypt(typedPath, options.encryptedPrefixes),
    });
    byHash.set(entry.sha256, candidates);
  }

  return byHash;
}

/**
 * Takes the vanished file whose bytes these are, and spends it.
 *
 * Spent, because two local files with identical contents must not both claim the
 * same Drive copy: the first gets the rename, the second is uploaded normally.
 *
 * The encryption rules have to agree on both sides before a rename is allowed. A
 * rename moves bytes that are already sealed, or already not; a path that wants
 * the other of those needs the file encrypted or decrypted, and only an upload
 * can do that. Both the rule at the old path and what Drive says it stored are
 * checked, because either one disagreeing means the answer is not certain.
 */
function takeMove(
  candidates: Map<string, MoveCandidate[]>,
  file: LocalFile,
  encrypt: boolean,
): MoveCandidate | null {
  const pool = candidates.get(file.sha256);
  if (pool === undefined) return null;

  const at = pool.findIndex(
    (candidate) =>
      candidate.entry.size === file.size &&
      candidate.wasEncrypted === encrypt &&
      candidate.encryptedFlag === encrypt,
  );
  if (at === -1) return null;

  const taken = pool[at];
  pool.splice(at, 1);
  if (pool.length === 0) candidates.delete(file.sha256);
  return taken ?? null;
}

/**
 * Decides what a push should do to each local file.
 *
 * Never plans an overwrite of a Drive file that changed since the last push —
 * those become `conflict` and are reported, not resolved. Geode is a backup
 * tool; it has no merge.
 *
 * A path with no index entry is usually a new file, but it can also be an old
 * one that moved. When some vanished path held exactly these bytes, the Drive
 * copy is renamed instead of being uploaded again — see `moveCandidates`.
 *
 * Does NOT read files or compute hashes: `local[].sha256` must already be the
 * plaintext digest.
 */
export function planPush(
  local: readonly LocalFile[],
  index: LocalIndex,
  remote: readonly RemoteFile[],
  options: PushOptions,
): PushPlan {
  const remoteByPath = byPath(remote);
  // Filtered here as well as by the caller, which skips reading them at all.
  // The planner is where the guarantee has to hold, and it is cheap to keep.
  const included = local.filter((file) => !isIgnored(options.ignore, file.path));
  const localPaths = new Set<string>(included.map((file) => file.path));
  const actions: PushAction[] = [];

  const candidates = moveCandidates(index, localPaths, remoteByPath, options);
  /** Source paths spent on a move. Their Drive copy left with the file. */
  const moved = new Set<string>();

  const sortedLocal = [...included].sort((a, b) => comparePaths(a.path, b.path));

  for (const file of sortedLocal) {
    const encrypt =
      options.encryptionEnabled && shouldEncrypt(file.path, options.encryptedPrefixes);
    const entry = index[file.path];
    const remoteFile = remoteByPath.get(file.path);

    if (entry === undefined) {
      // Nothing in the index. If Drive already has this path it was written by
      // someone else, or by this vault before the index was lost — either way we
      // do not know what is in it, so we refuse to overwrite.
      if (remoteFile !== undefined) {
        actions.push({ type: 'conflict', path: file.path, fileId: remoteFile.id });
        continue;
      }

      // Unindexed and unknown to Drive under this name — but the bytes may
      // already be up there under the name this file used to have.
      const source = takeMove(candidates, file, encrypt);
      if (source === null) {
        actions.push({ type: 'upload', path: file.path, encrypt });
      } else {
        moved.add(source.path);
        actions.push({
          type: 'move-remote',
          path: file.path,
          from: source.path,
          fileId: source.fileId,
        });
      }
      continue;
    }

    if (remoteFile === undefined) {
      // Indexed but gone from Drive. Put it back.
      actions.push({ type: 'upload', path: file.path, encrypt });
      continue;
    }

    const localChanged = entry.sha256 !== file.sha256;
    const remoteChanged = remoteWasRewritten(entry.remoteMd5, remoteFile.md5);

    if (!localChanged) {
      actions.push({
        type: 'skip',
        path: file.path,
        reason: remoteChanged ? 'remote-changed-locally-unchanged' : 'unchanged',
      });
    } else if (remoteChanged) {
      actions.push({ type: 'conflict', path: file.path, fileId: remoteFile.id });
    } else {
      actions.push({ type: 'update', path: file.path, fileId: remoteFile.id, encrypt });
    }
  }

  const indexedPaths = Object.keys(index).sort(comparePaths);
  const forget: VaultPath[] = [];
  for (const path of indexedPaths) {
    if (localPaths.has(path)) continue;

    // Its Drive copy is the one being renamed, and its index entry travels with
    // it. Falling through would plan a delete of the file we just moved.
    if (moved.has(path)) continue;

    const typedPath = vaultPath(path);

    // Excluded, not deleted. The file may well still be sitting on disk — it is
    // missing from `localPaths` because the exclusion removed it, not because
    // the user threw it away. Falling through would hand it to the deletion
    // branch, and adding a folder to .gitignore would erase its Drive copy.
    if (isIgnored(options.ignore, typedPath)) {
      actions.push({ type: 'skip', path: typedPath, reason: 'excluded' });
      continue;
    }

    const remoteFile = remoteByPath.get(path);
    if (remoteFile === undefined) {
      // Gone from the vault and gone from Drive. The entry describes nothing and
      // only inflates data.json and the tracked-file count. Dropping it changes
      // no decision: should the file ever come back, an unindexed path with no
      // Drive copy is uploaded either way.
      forget.push(typedPath);
      continue;
    }

    if (options.mirrorDeletions) {
      actions.push({ type: 'delete-remote', path: typedPath, fileId: remoteFile.id });
    } else {
      actions.push({ type: 'skip', path: typedPath, reason: 'deleted-locally' });
    }
  }

  return { actions, forget };
}

/**
 * Picks a free path for an incoming file whose path is already occupied.
 *
 * `notes/a.md` becomes `notes/a (from drive).md`, then `notes/a (from drive 2).md`
 * and so on. Never returns a path already in `taken`, which is what keeps pull
 * from destroying local work.
 *
 * `taken` holds folded paths — see `foldPath`. Candidates are folded before the
 * lookup, so a free name is free on a case-insensitive filesystem too.
 */
export function collisionPath(path: VaultPath, taken: ReadonlySet<string>): VaultPath {
  const slash = path.lastIndexOf('/');
  const folder = slash === -1 ? '' : path.slice(0, slash + 1);
  const base = path.slice(slash + 1);

  // A leading dot is part of the name, not an extension: `.gitignore` has none.
  const dot = base.lastIndexOf('.');
  const hasExtension = dot > 0;
  const stem = hasExtension ? base.slice(0, dot) : base;
  const extension = hasExtension ? base.slice(dot) : '';

  for (let attempt = 1; attempt < 10_000; attempt += 1) {
    const suffix = attempt === 1 ? ' (from drive)' : ` (from drive ${String(attempt)})`;
    const candidate = `${folder}${stem}${suffix}${extension}`;
    if (!taken.has(foldPath(candidate))) return vaultPath(candidate);
  }

  throw new Error(`Could not find a free name for ${path}`);
}

/**
 * Decides what a pull should write.
 *
 * Never plans a delete and never plans an overwrite. A local file that differs
 * from the Drive copy stays exactly where it is and the download lands beside it
 * under a new name.
 *
 * "Differs" is inferred, not measured: a local file counts as identical only
 * when the index says its plaintext hash and the Drive md5 both still match.
 * Without an index entry — a fresh device, or a lost data.json — every existing
 * file is treated as different, so pull errs toward keeping both copies.
 *
 * Whether a path is occupied is decided case-insensitively, because most of the
 * filesystems a vault lives on are. See `foldPath`.
 */
export function planPull(
  remote: readonly RemoteFile[],
  local: readonly LocalFile[],
  index: LocalIndex,
): PullPlan {
  const localByPath = byPath(local);
  const taken = new Set<string>(local.map((file) => foldPath(file.path)));
  const actions: PullAction[] = [];

  const sortedRemote = [...remote].sort((a, b) => comparePaths(a.path, b.path));

  for (const file of sortedRemote) {
    if (!taken.has(foldPath(file.path))) {
      actions.push({ type: 'download', path: file.path, fileId: file.id, writeTo: file.path });
      taken.add(foldPath(file.path));
      continue;
    }

    const localFile = localByPath.get(file.path);
    const entry = index[file.path];

    if (localFile !== undefined && entry !== undefined) {
      // Identical only if the index vouches for both sides: the local plaintext
      // still hashes to what we pushed, and Drive still holds those same bytes.
      const identical =
        entry.sha256 === localFile.sha256 &&
        entry.remoteMd5.length > 0 &&
        entry.remoteMd5 === file.md5;

      if (identical) {
        actions.push({ type: 'skip', path: file.path, reason: 'already-identical' });
        continue;
      }
    }

    const writeTo = collisionPath(file.path, taken);
    taken.add(foldPath(writeTo));
    actions.push({ type: 'rename-on-collision', path: file.path, fileId: file.id, writeTo });
  }

  return { actions };
}
