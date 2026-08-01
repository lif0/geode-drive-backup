import { describe, expect, it } from 'vitest';

import { fileExtension, isBackedUp, summarizeVault } from '../src/core/vault-stats';
import type { IndexEntry, LocalIndex, VaultFileStat, VaultPath } from '../src/types';
import { driveFileId, sha256Hex, vaultPath } from '../src/types';

function stat(path: string, size = 100, mtime = 1_000): VaultFileStat {
  return { path: vaultPath(path), mtime, size };
}

function entry(mtime = 1_000, size = 100): IndexEntry {
  return {
    sha256: sha256Hex('a'.repeat(64)),
    driveFileId: driveFileId('drive-id'),
    remoteMd5: 'md5',
    mtime,
    size,
  };
}

function index(...pairs: readonly (readonly [string, IndexEntry])[]): LocalIndex {
  const out: LocalIndex = {};
  for (const [path, value] of pairs) out[vaultPath(path)] = value;
  return out;
}

/** Nothing is excluded unless a test says so. */
const nothingExcluded = (): boolean => false;

describe('isBackedUp', () => {
  it('needs an entry whose mtime and size both still match', () => {
    expect(isBackedUp(entry(5, 10), { mtime: 5, size: 10 })).toBe(true);
    expect(isBackedUp(entry(5, 10), { mtime: 6, size: 10 })).toBe(false);
    expect(isBackedUp(entry(5, 10), { mtime: 5, size: 11 })).toBe(false);
    expect(isBackedUp(undefined, { mtime: 5, size: 10 })).toBe(false);
  });
});

describe('fileExtension', () => {
  it('takes the part after the last dot, lowercased', () => {
    expect(fileExtension('Notes/Daily.MD')).toBe('md');
    expect(fileExtension('a/b/clip.tar.gz')).toBe('gz');
  });

  it('treats a leading dot as a name, not an extension', () => {
    expect(fileExtension('.gitignore')).toBe('');
    expect(fileExtension('some/.env')).toBe('');
  });

  it('answers empty when there is no dot in the name', () => {
    expect(fileExtension('Makefile')).toBe('');
    expect(fileExtension('folder.v2/README')).toBe('');
  });
});

describe('summarizeVault', () => {
  it('splits the vault into backed up, pending and excluded', () => {
    const files = [stat('kept.md', 10), stat('edited.md', 20, 2_000), stat('new.md', 30)];
    const summary = summarizeVault(
      files,
      index(['kept.md', entry(1_000, 10)], ['edited.md', entry(1_000, 20)]),
      (path) => path === 'new.md',
    );

    expect(summary.files).toBe(3);
    expect(summary.bytes).toBe(60);
    expect(summary.backedUp).toBe(1);
    expect(summary.excluded).toBe(1);
    expect(summary.excludedBytes).toBe(30);
    expect(summary.included).toBe(2);
    expect(summary.includedBytes).toBe(30);
    expect(summary.pending.map((file) => file.path)).toEqual(['edited.md']);
    expect(summary.pendingBytes).toBe(20);
  });

  it('calls a file the index has never seen an add, and a changed one a modify', () => {
    const summary = summarizeVault(
      [stat('fresh.md'), stat('changed.md', 100, 9_999)],
      index(['changed.md', entry(1_000, 100)]),
      nothingExcluded,
    );

    expect(summary.pending).toEqual([
      { path: 'changed.md', bytes: 100, kind: 'modify' },
      { path: 'fresh.md', bytes: 100, kind: 'add' },
    ]);
  });

  it('reports index entries with no file behind them as orphans', () => {
    const summary = summarizeVault(
      [stat('here.md')],
      index(['here.md', entry()], ['gone.md', entry(1_000, 4_096)], ['old.md', entry(1_000, -1)]),
      nothingExcluded,
    );

    expect(summary.orphans).toEqual([
      { path: 'gone.md', bytes: 4_096 },
      { path: 'old.md', bytes: 0 },
    ]);
    // The legacy entry has no recorded size, so it adds nothing rather than
    // inventing bytes.
    expect(summary.orphanBytes).toBe(4_096);
  });

  it('groups by extension, heaviest first', () => {
    const summary = summarizeVault(
      [stat('a.md', 10), stat('b.md', 20), stat('c.mp4', 500), stat('Makefile', 5)],
      {},
      nothingExcluded,
    );

    expect(summary.byType).toEqual([
      { extension: 'mp4', files: 1, bytes: 500 },
      { extension: 'md', files: 2, bytes: 30 },
      { extension: '', files: 1, bytes: 5 },
    ]);
  });

  it('lists the most recently edited files, newest first, with their state', () => {
    const summary = summarizeVault(
      [stat('old.md', 10, 1), stat('new.md', 10, 3), stat('mid.md', 10, 2)],
      index(['new.md', entry(3, 10)]),
      (path: VaultPath) => path === 'old.md',
    );

    expect(summary.recent).toEqual([
      { path: 'new.md', mtime: 3, state: 'backed-up' },
      { path: 'mid.md', mtime: 2, state: 'pending' },
      { path: 'old.md', mtime: 1, state: 'excluded' },
    ]);
  });

  it('caps the recent list', () => {
    const files = Array.from({ length: 20 }, (_, at) => stat(`note-${String(at)}.md`, 1, at));
    expect(summarizeVault(files, {}, nothingExcluded).recent).toHaveLength(6);
  });

  it('says nothing at all about an empty vault', () => {
    const summary = summarizeVault([], {}, nothingExcluded);
    expect(summary).toMatchObject({
      files: 0,
      bytes: 0,
      backedUp: 0,
      pendingBytes: 0,
      orphanBytes: 0,
    });
    expect(summary.byType).toEqual([]);
    expect(summary.recent).toEqual([]);
  });
});
