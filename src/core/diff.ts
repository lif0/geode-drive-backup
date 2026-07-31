import type {
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
 * Decides what a push should do to each local file.
 *
 * Never plans an overwrite of a Drive file that changed since the last push —
 * those become `conflict` and are reported, not resolved. Geode is a backup
 * tool; it has no merge.
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
  const localPaths = new Set<string>(local.map((file) => file.path));
  const actions: PushAction[] = [];

  const sortedLocal = [...local].sort((a, b) => comparePaths(a.path, b.path));

  for (const file of sortedLocal) {
    const encrypt =
      options.encryptionEnabled && shouldEncrypt(file.path, options.encryptedPrefixes);
    const entry = index[file.path];
    const remoteFile = remoteByPath.get(file.path);

    if (entry === undefined) {
      // Nothing in the index. If Drive already has this path it was written by
      // someone else, or by this vault before the index was lost — either way we
      // do not know what is in it, so we refuse to overwrite.
      if (remoteFile === undefined) {
        actions.push({ type: 'upload', path: file.path, encrypt });
      } else {
        actions.push({ type: 'conflict', path: file.path, fileId: remoteFile.id });
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
  for (const path of indexedPaths) {
    if (localPaths.has(path)) continue;

    const remoteFile = remoteByPath.get(path);
    if (remoteFile === undefined) continue;

    const typedPath = vaultPath(path);
    if (options.mirrorDeletions) {
      actions.push({ type: 'delete-remote', path: typedPath, fileId: remoteFile.id });
    } else {
      actions.push({ type: 'skip', path: typedPath, reason: 'deleted-locally' });
    }
  }

  return { actions };
}

/**
 * Picks a free path for an incoming file whose path is already occupied.
 *
 * `notes/a.md` becomes `notes/a (from drive).md`, then `notes/a (from drive 2).md`
 * and so on. Never returns a path in `taken`, which is what keeps pull from
 * destroying local work.
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
    if (!taken.has(candidate)) return vaultPath(candidate);
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
 */
export function planPull(
  remote: readonly RemoteFile[],
  local: readonly LocalFile[],
  index: LocalIndex,
): PullPlan {
  const localByPath = byPath(local);
  const taken = new Set<string>(local.map((file) => file.path));
  const actions: PullAction[] = [];

  const sortedRemote = [...remote].sort((a, b) => comparePaths(a.path, b.path));

  for (const file of sortedRemote) {
    if (!taken.has(file.path)) {
      actions.push({ type: 'download', path: file.path, fileId: file.id, writeTo: file.path });
      taken.add(file.path);
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
    taken.add(writeTo);
    actions.push({ type: 'rename-on-collision', path: file.path, fileId: file.id, writeTo });
  }

  return { actions };
}
