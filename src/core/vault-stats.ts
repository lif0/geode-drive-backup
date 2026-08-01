/**
 * What the vault looks like from the backup's point of view.
 *
 * Every number here comes from file stats Obsidian already holds in memory plus
 * the local index, so the whole summary costs one pass over a list and opens no
 * file and touches no network. That is the point: the panel can show it the
 * moment it is drawn, and redraw it whenever anything changes, where the honest
 * answer — the one a push works out by hashing the vault and listing Drive — is
 * expensive enough to live behind a button.
 *
 * The two answers can disagree, and the summary is the pessimistic one: it calls
 * a file pending whenever the index cannot prove it is not. See `isBackedUp`.
 */

import type { BackupState } from './backup-state';
import type { IndexEntry, LocalIndex, VaultFileStat, VaultPath } from '../types';

/** How many of the most recently edited files the panel lists. */
export const RECENT_LIMIT = 6;

/**
 * True when the index entry still describes the file on disk.
 *
 * The same shortcut a push takes to decide it need not read the file again, so
 * the explorer dots, the panel and the push all give one answer. It is a claim
 * about mtime and size only — a file edited and put back the way it was fails
 * this and shows as pending until something hashes it.
 */
export function isBackedUp(
  entry: IndexEntry | undefined,
  stat: { readonly mtime: number; readonly size: number },
): boolean {
  return entry?.mtime === stat.mtime && entry.size === stat.size;
}

/**
 * The extension, lowercased and without its dot, or `''` for a file that has
 * none. A leading dot does not count: `.gitignore` is a name, not an extension.
 */
export function fileExtension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** One extension's share of the vault. */
export interface TypeUsage {
  /** Lowercase and without the dot. Empty for files with no extension. */
  readonly extension: string;
  readonly files: number;
  readonly bytes: number;
}

/** A file the vault changed recently, and where the backup stands on it. */
export interface RecentFile {
  readonly path: VaultPath;
  readonly mtime: number;
  readonly state: BackupState;
}

/** A file a push would send, and why. */
export interface PendingFile {
  readonly path: VaultPath;
  readonly bytes: number;
  /** `add` when Drive has never seen this path, `modify` when it has. */
  readonly kind: 'add' | 'modify';
}

/**
 * A file the backup still holds that the vault no longer has.
 *
 * Deleting a note does not delete its Drive copy unless mirroring is switched
 * on, which is the safe default and also the way a backup quietly fills up with
 * things nobody wants back.
 */
export interface OrphanFile {
  readonly path: VaultPath;
  /** From the index. `0` for an entry written before sizes were recorded. */
  readonly bytes: number;
}

/** One pass over the vault, as the panel reads it. */
export interface VaultSummary {
  /** Files Obsidian tracks, excluded ones included. */
  readonly files: number;
  readonly bytes: number;
  /** Files the exclusion rules let through — the ones a push considers. */
  readonly included: number;
  readonly includedBytes: number;
  readonly excluded: number;
  readonly excludedBytes: number;
  /** Included files the index cannot prove are already on Drive. */
  readonly pending: readonly PendingFile[];
  readonly pendingBytes: number;
  /** Included files the index says are on Drive and unchanged since. */
  readonly backedUp: number;
  /** Index entries with no file behind them, newest first is not meaningful here. */
  readonly orphans: readonly OrphanFile[];
  readonly orphanBytes: number;
  /** Every extension present, heaviest first. */
  readonly byType: readonly TypeUsage[];
  /** The most recently modified files, newest first. */
  readonly recent: readonly RecentFile[];
}

/**
 * Summarises the vault against the index in one pass.
 *
 * `isExcluded` is passed in rather than the rules themselves so the caller can
 * hand over the compiled set it already keeps warm for the explorer dots, and so
 * this module stays free of the ignore syntax.
 */
export function summarizeVault(
  files: readonly VaultFileStat[],
  index: LocalIndex,
  isExcluded: (path: VaultPath) => boolean,
): VaultSummary {
  const byType = new Map<string, { files: number; bytes: number }>();
  const pending: PendingFile[] = [];
  const recent: RecentFile[] = [];
  const live = new Set<string>();

  let bytes = 0;
  let included = 0;
  let includedBytes = 0;
  let excludedFiles = 0;
  let excludedBytes = 0;
  let pendingBytes = 0;
  let backedUp = 0;

  for (const stat of files) {
    live.add(stat.path);
    bytes += stat.size;

    const extension = fileExtension(stat.path);
    const usage = byType.get(extension) ?? { files: 0, bytes: 0 };
    usage.files += 1;
    usage.bytes += stat.size;
    byType.set(extension, usage);

    if (isExcluded(stat.path)) {
      excludedFiles += 1;
      excludedBytes += stat.size;
      recent.push({ path: stat.path, mtime: stat.mtime, state: 'excluded' });
      continue;
    }

    included += 1;
    includedBytes += stat.size;

    const entry = index[stat.path];
    if (isBackedUp(entry, stat)) {
      backedUp += 1;
      recent.push({ path: stat.path, mtime: stat.mtime, state: 'backed-up' });
      continue;
    }

    pending.push({
      path: stat.path,
      bytes: stat.size,
      kind: entry === undefined ? 'add' : 'modify',
    });
    pendingBytes += stat.size;
    recent.push({ path: stat.path, mtime: stat.mtime, state: 'pending' });
  }

  const orphans: OrphanFile[] = [];
  let orphanBytes = 0;
  for (const [path, entry] of Object.entries(index)) {
    if (live.has(path)) continue;
    // A negative size is an entry written before sizes were recorded; counting
    // it as nothing understates the orphan pile rather than inventing bytes.
    const size = Math.max(0, entry.size);
    orphans.push({ path: path as VaultPath, bytes: size });
    orphanBytes += size;
  }

  return {
    files: files.length,
    bytes,
    included,
    includedBytes,
    excluded: excludedFiles,
    excludedBytes,
    pending: sortByBytes(pending),
    pendingBytes,
    backedUp,
    orphans: orphans.sort((a, b) => b.bytes - a.bytes || compareText(a.path, b.path)),
    orphanBytes,
    byType: sortTypes(byType),
    // Sorted at the end rather than kept in a heap: a vault is thousands of
    // files, not millions, and one sort a repaint is cheaper than the bookkeeping
    // that would avoid it.
    recent: recent.sort((a, b) => b.mtime - a.mtime).slice(0, RECENT_LIMIT),
  };
}

/** Heaviest first, then alphabetical so equal weights do not shuffle. */
function sortByBytes(files: readonly PendingFile[]): PendingFile[] {
  return [...files].sort((a, b) => b.bytes - a.bytes || compareText(a.path, b.path));
}

function sortTypes(byType: ReadonlyMap<string, { files: number; bytes: number }>): TypeUsage[] {
  return [...byType.entries()]
    .map(([extension, usage]) => ({ extension, files: usage.files, bytes: usage.bytes }))
    .sort((a, b) => b.bytes - a.bytes || compareText(a.extension, b.extension));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
