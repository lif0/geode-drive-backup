import { describe, expect, it } from 'vitest';

import { collisionPath, planPull, planPush } from '../src/core/diff';
import type { PushOptions } from '../src/core/diff';
import { encodePath } from '../src/core/path-codec';
import type {
  DriveFileId,
  IndexEntry,
  LocalFile,
  LocalIndex,
  RemoteFile,
  Sha256Hex,
  VaultPath,
} from '../src/types';
import { driveFileId, sha256Hex, vaultPath } from '../src/types';

/* ------------------------------ builders ---------------------------------- */

let counter = 0;

/** A distinct, well-formed digest per label, so tests read as "content A vs B". */
function digest(label: string): Sha256Hex {
  let hex = '';
  for (let i = 0; i < label.length; i += 1) {
    hex += label.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return sha256Hex(hex.padEnd(64, '0').slice(0, 64));
}

function local(path: string, content = 'a'): LocalFile {
  counter += 1;
  return { path: vaultPath(path), sha256: digest(content), mtime: counter, size: 10 };
}

function remote(path: string, md5 = 'md5-a', id?: string): RemoteFile {
  const typed = vaultPath(path);
  return {
    id: driveFileId(id ?? `id-${path}`),
    name: encodePath(typed),
    path: typed,
    md5,
    modifiedTime: '2026-08-01T00:00:00.000Z',
    size: 10,
    encryptedFlag: false,
  };
}

function entry(content: string, md5: string, id?: string): IndexEntry {
  return {
    sha256: digest(content),
    driveFileId: driveFileId(id ?? 'id-x'),
    remoteMd5: md5,
    mtime: 1,
  };
}

function index(pairs: Record<string, IndexEntry>): LocalIndex {
  return pairs;
}

const PLAIN: PushOptions = {
  encryptionEnabled: false,
  encryptedPrefixes: [],
  mirrorDeletions: false,
};

/* -------------------------------- push ------------------------------------ */

describe('planPush', () => {
  it('uploads a file that is in neither the index nor Drive', () => {
    const plan = planPush([local('a.md')], index({}), [], PLAIN);
    expect(plan.actions).toEqual([{ type: 'upload', path: 'a.md', encrypt: false }]);
  });

  it('skips a file whose plaintext hash still matches the index', () => {
    const plan = planPush(
      [local('a.md', 'same')],
      index({ 'a.md': entry('same', 'md5-a') }),
      [remote('a.md', 'md5-a')],
      PLAIN,
    );
    expect(plan.actions).toEqual([{ type: 'skip', path: 'a.md', reason: 'unchanged' }]);
  });

  it('updates a file whose plaintext changed while Drive stayed put', () => {
    const plan = planPush(
      [local('a.md', 'new')],
      index({ 'a.md': entry('old', 'md5-a') }),
      [remote('a.md', 'md5-a', 'drive-1')],
      PLAIN,
    );
    expect(plan.actions).toEqual([
      { type: 'update', path: 'a.md', fileId: 'drive-1', encrypt: false },
    ]);
  });

  it('refuses to overwrite a file another device rewrote', () => {
    const plan = planPush(
      [local('a.md', 'new')],
      index({ 'a.md': entry('old', 'md5-a') }),
      [remote('a.md', 'md5-CHANGED', 'drive-1')],
      PLAIN,
    );
    expect(plan.actions).toEqual([{ type: 'conflict', path: 'a.md', fileId: 'drive-1' }]);
  });

  it('reports a remote-only change even when there is nothing to push', () => {
    const plan = planPush(
      [local('a.md', 'same')],
      index({ 'a.md': entry('same', 'md5-a') }),
      [remote('a.md', 'md5-CHANGED')],
      PLAIN,
    );
    expect(plan.actions).toEqual([
      { type: 'skip', path: 'a.md', reason: 'remote-changed-locally-unchanged' },
    ]);
  });

  it('treats an unindexed file that already exists on Drive as a conflict', () => {
    // Happens when data.json was lost. We cannot know what is in the Drive copy.
    const plan = planPush([local('a.md')], index({}), [remote('a.md', 'md5-a', 'drive-1')], PLAIN);
    expect(plan.actions).toEqual([{ type: 'conflict', path: 'a.md', fileId: 'drive-1' }]);
  });

  it('re-uploads an indexed file that vanished from Drive', () => {
    const plan = planPush(
      [local('a.md', 'same')],
      index({ 'a.md': entry('same', 'md5-a') }),
      [],
      PLAIN,
    );
    expect(plan.actions).toEqual([{ type: 'upload', path: 'a.md', encrypt: false }]);
  });

  it('does not call a missing md5 a conflict', () => {
    // Drive omits md5Checksum for some files. Unknown must not read as changed.
    const plan = planPush(
      [local('a.md', 'new')],
      index({ 'a.md': entry('old', '') }),
      [remote('a.md', '', 'drive-1')],
      PLAIN,
    );
    expect(plan.actions).toEqual([
      { type: 'update', path: 'a.md', fileId: 'drive-1', encrypt: false },
    ]);
  });

  it('never re-uploads on a second push with unchanged content', () => {
    // The regression this whole design exists to prevent: encrypted files get a
    // fresh nonce every push, so a ciphertext-based check re-uploads everything.
    const files = [local('Journal/a.md', 'x'), local('b.md', 'y')];
    const state = index({
      'Journal/a.md': entry('x', 'md5-1'),
      'b.md': entry('y', 'md5-2'),
    });
    const drive = [remote('Journal/a.md', 'md5-1'), remote('b.md', 'md5-2')];

    const plan = planPush(files, state, drive, {
      encryptionEnabled: true,
      encryptedPrefixes: ['Journal'],
      mirrorDeletions: false,
    });

    expect(plan.actions.every((action) => action.type === 'skip')).toBe(true);
  });

  describe('encryption selection', () => {
    const options: PushOptions = {
      encryptionEnabled: true,
      encryptedPrefixes: ['Journal'],
      mirrorDeletions: false,
    };

    it('flags only files under a configured prefix', () => {
      const plan = planPush([local('Journal/a.md'), local('b.md')], index({}), [], options);
      expect(plan.actions).toEqual([
        { type: 'upload', path: 'Journal/a.md', encrypt: true },
        { type: 'upload', path: 'b.md', encrypt: false },
      ]);
    });

    it('flags nothing while encryption is switched off', () => {
      const plan = planPush([local('Journal/a.md')], index({}), [], {
        ...options,
        encryptionEnabled: false,
      });
      expect(plan.actions).toEqual([{ type: 'upload', path: 'Journal/a.md', encrypt: false }]);
    });

    it('carries the flag onto an update as well as an upload', () => {
      const plan = planPush(
        [local('Journal/a.md', 'new')],
        index({ 'Journal/a.md': entry('old', 'md5-a') }),
        [remote('Journal/a.md', 'md5-a', 'drive-1')],
        options,
      );
      expect(plan.actions).toEqual([
        { type: 'update', path: 'Journal/a.md', fileId: 'drive-1', encrypt: true },
      ]);
    });
  });

  describe('deletions', () => {
    const state = index({ 'gone.md': entry('x', 'md5-a') });
    const drive = [remote('gone.md', 'md5-a', 'drive-9')];

    it('leaves the Drive copy alone by default', () => {
      const plan = planPush([], state, drive, PLAIN);
      expect(plan.actions).toEqual([{ type: 'skip', path: 'gone.md', reason: 'deleted-locally' }]);
    });

    it('deletes the Drive copy when mirroring is switched on', () => {
      const plan = planPush([], state, drive, { ...PLAIN, mirrorDeletions: true });
      expect(plan.actions).toEqual([
        { type: 'delete-remote', path: 'gone.md', fileId: 'drive-9' },
      ]);
    });

    it('says nothing about a file already gone from both sides', () => {
      expect(planPush([], state, [], { ...PLAIN, mirrorDeletions: true }).actions).toEqual([]);
    });

    it('ignores a Drive file that was never indexed', () => {
      // Someone else's file in the folder, or one this device has not pulled.
      expect(planPush([], index({}), [remote('theirs.md')], PLAIN).actions).toEqual([]);
    });
  });

  it('orders actions by path so plans are reproducible', () => {
    const plan = planPush([local('c.md'), local('a.md'), local('b.md')], index({}), [], PLAIN);
    expect(plan.actions.map((action) => action.path)).toEqual(['a.md', 'b.md', 'c.md']);
  });
});

/* -------------------------------- pull ------------------------------------ */

describe('planPull', () => {
  it('downloads everything onto a fresh device', () => {
    const plan = planPull([remote('a.md'), remote('folder/b.md')], [], index({}));
    expect(plan.actions).toEqual([
      { type: 'download', path: 'a.md', fileId: 'id-a.md', writeTo: 'a.md' },
      {
        type: 'download',
        path: 'folder/b.md',
        fileId: 'id-folder/b.md',
        writeTo: 'folder/b.md',
      },
    ]);
  });

  it('skips a local file the index proves is already identical', () => {
    const plan = planPull(
      [remote('a.md', 'md5-a')],
      [local('a.md', 'same')],
      index({ 'a.md': entry('same', 'md5-a') }),
    );
    expect(plan.actions).toEqual([{ type: 'skip', path: 'a.md', reason: 'already-identical' }]);
  });

  it('writes beside a local file whose content differs', () => {
    const plan = planPull(
      [remote('a.md', 'md5-NEW')],
      [local('a.md', 'mine')],
      index({ 'a.md': entry('mine', 'md5-a') }),
    );
    expect(plan.actions).toEqual([
      {
        type: 'rename-on-collision',
        path: 'a.md',
        fileId: 'id-a.md',
        writeTo: 'a (from drive).md',
      },
    ]);
  });

  it('writes beside a local file when there is no index to vouch for it', () => {
    // Fresh install over an existing vault. Nothing is known, so nothing is lost.
    const plan = planPull([remote('a.md')], [local('a.md')], index({}));
    expect(plan.actions).toEqual([
      {
        type: 'rename-on-collision',
        path: 'a.md',
        fileId: 'id-a.md',
        writeTo: 'a (from drive).md',
      },
    ]);
  });

  it('never plans a delete or an overwrite', () => {
    const plan = planPull(
      [remote('a.md', 'md5-NEW'), remote('b.md')],
      [local('a.md'), local('c.md')],
      index({}),
    );
    const writes = plan.actions.flatMap((action) =>
      action.type === 'skip' ? [] : [action.writeTo as string],
    );
    expect(writes).not.toContain('a.md');
    expect(writes).not.toContain('c.md');
  });

  it('numbers repeated collisions instead of clobbering the first copy', () => {
    const plan = planPull([remote('a.md'), remote('a.md'), remote('a.md')], [local('a.md')], index({}));
    expect(plan.actions.map((action) => (action.type === 'skip' ? null : action.writeTo))).toEqual([
      'a (from drive).md',
      'a (from drive 2).md',
      'a (from drive 3).md',
    ]);
  });

  it('orders actions by path so plans are reproducible', () => {
    const plan = planPull([remote('c.md'), remote('a.md'), remote('b.md')], [], index({}));
    expect(plan.actions.map((action) => action.path)).toEqual(['a.md', 'b.md', 'c.md']);
  });
});

describe('collisionPath', () => {
  const free = new Set<string>();
  const taken = (...paths: string[]): ReadonlySet<string> => new Set(paths);
  const at = (path: string, occupied: ReadonlySet<string> = free): VaultPath =>
    collisionPath(vaultPath(path), occupied);

  it('inserts the marker before the extension', () => {
    expect(at('a.md')).toBe('a (from drive).md');
    expect(at('folder/sub/note.md')).toBe('folder/sub/note (from drive).md');
  });

  it('keeps only the final extension', () => {
    expect(at('archive.tar.gz')).toBe('archive.tar (from drive).gz');
  });

  it('appends the marker when there is no extension', () => {
    expect(at('README')).toBe('README (from drive)');
    expect(at('folder/README')).toBe('folder/README (from drive)');
  });

  it('treats a leading dot as part of the name, not an extension', () => {
    expect(at('.gitignore')).toBe('.gitignore (from drive)');
    expect(at('folder/.env')).toBe('folder/.env (from drive)');
  });

  it('counts upward past names that are already used', () => {
    expect(at('a.md', taken('a (from drive).md'))).toBe('a (from drive 2).md');
    expect(at('a.md', taken('a (from drive).md', 'a (from drive 2).md'))).toBe(
      'a (from drive 3).md',
    );
  });

  it('preserves non-ascii names', () => {
    expect(at('Заметки/личное.md')).toBe('Заметки/личное (from drive).md');
  });
});

/* ------------------------- branded type guards ---------------------------- */

describe('branded constructors', () => {
  it('reject paths that would escape the vault', () => {
    expect(() => vaultPath('../escape.md')).toThrow();
    expect(() => vaultPath('/absolute.md')).toThrow();
    expect(() => vaultPath('')).toThrow();
    expect(() => vaultPath('a\\b.md')).toThrow();
  });

  it('reject a digest that is not 64 lowercase hex characters', () => {
    expect(() => sha256Hex('abc')).toThrow();
    expect(() => sha256Hex('A'.repeat(64))).toThrow();
    expect(() => sha256Hex('g'.repeat(64))).toThrow();
    expect(sha256Hex('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('reject an empty Drive file id', () => {
    expect(() => driveFileId('')).toThrow();
    const id: DriveFileId = driveFileId('1a2b3c');
    expect(id).toBe('1a2b3c');
  });
});
