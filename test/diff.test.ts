import { describe, expect, it } from 'vitest';

import { collisionPath, planPull, planPush } from '../src/core/diff';
import type { PushOptions } from '../src/core/diff';
import { NO_IGNORE_RULES, parseIgnore } from '../src/core/ignore';
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
    size: 10,
  };
}

function index(pairs: Record<string, IndexEntry>): LocalIndex {
  return pairs;
}

const PLAIN: PushOptions = {
  encryptionEnabled: false,
  encryptedPrefixes: [],
  mirrorDeletions: false,
  ignore: NO_IGNORE_RULES,
};

/** PLAIN plus exclusion rules, written as .gitignore lines. */
function excluding(...lines: string[]): PushOptions {
  return { ...PLAIN, ignore: parseIgnore(lines.join('\n')) };
}

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
      ...PLAIN,
      encryptionEnabled: true,
      encryptedPrefixes: ['Journal'],
    });

    expect(plan.actions.every((action) => action.type === 'skip')).toBe(true);
  });

  describe('encryption selection', () => {
    const options: PushOptions = {
      ...PLAIN,
      encryptionEnabled: true,
      encryptedPrefixes: ['Journal'],
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
      expect(plan.actions).toEqual([{ type: 'delete-remote', path: 'gone.md', fileId: 'drive-9' }]);
    });

    it('says nothing about a file already gone from both sides', () => {
      expect(planPush([], state, [], { ...PLAIN, mirrorDeletions: true }).actions).toEqual([]);
    });

    it('forgets an index entry gone from both sides', () => {
      expect(planPush([], state, [], PLAIN).forget).toEqual(['gone.md']);
    });

    it('keeps the entry while Drive still holds the file', () => {
      expect(planPush([], state, drive, PLAIN).forget).toEqual([]);
    });

    it('ignores a Drive file that was never indexed', () => {
      // Someone else's file in the folder, or one this device has not pulled.
      expect(planPush([], index({}), [remote('theirs.md')], PLAIN).actions).toEqual([]);
    });
  });

  describe('exclusions', () => {
    it('leaves an excluded file out of the plan entirely', () => {
      const plan = planPush(
        [local('bin/tool.exe'), local('note.md')],
        index({}),
        [],
        excluding('bin/'),
      );
      expect(plan.actions).toEqual([{ type: 'upload', path: 'note.md', encrypt: false }]);
    });

    it('never deletes the Drive copy of a newly excluded file', () => {
      // The regression that would make this feature dangerous: excluding a
      // folder must not be read as deleting it, or adding a line to .gitignore
      // would wipe the backup of everything it covers.
      const state = index({ 'bin/tool.exe': entry('x', 'md5-a') });
      const drive = [remote('bin/tool.exe', 'md5-a', 'drive-7')];

      const plan = planPush([local('bin/tool.exe')], state, drive, {
        ...excluding('bin/'),
        mirrorDeletions: true,
      });

      expect(plan.actions).toEqual([{ type: 'skip', path: 'bin/tool.exe', reason: 'excluded' }]);
      expect(plan.forget).toEqual([]);
    });

    it('does not re-upload an excluded file that is already on Drive', () => {
      const state = index({ 'bin/tool.exe': entry('x', 'md5-a') });
      const plan = planPush([local('bin/tool.exe', 'y')], state, [], excluding('bin/'));
      expect(plan.actions).toEqual([{ type: 'skip', path: 'bin/tool.exe', reason: 'excluded' }]);
    });
  });

  describe('moves', () => {
    it('renames on Drive instead of re-uploading a file that moved', () => {
      const state = index({ 'popka/big.bin': entry('big', 'md5-big', 'id-big') });
      const plan = planPush(
        [local('jopka/big.bin', 'big')],
        state,
        [remote('popka/big.bin', 'md5-big', 'id-big')],
        PLAIN,
      );

      expect(plan.actions).toEqual([
        { type: 'move-remote', path: 'jopka/big.bin', from: 'popka/big.bin', fileId: 'id-big' },
      ]);
      // The old path must not also be planned for deletion, and must not be
      // forgotten: its entry travels to the new path.
      expect(plan.forget).toEqual([]);
    });

    it('mirrors nothing when a move is what happened, even with mirroring on', () => {
      const state = index({ 'popka/big.bin': entry('big', 'md5-big', 'id-big') });
      const plan = planPush(
        [local('jopka/big.bin', 'big')],
        state,
        [remote('popka/big.bin', 'md5-big', 'id-big')],
        { ...PLAIN, mirrorDeletions: true },
      );

      expect(plan.actions.map((action) => action.type)).toEqual(['move-remote']);
    });

    it('uploads a copy rather than moving the original away', () => {
      const state = index({ 'popka/big.bin': entry('big', 'md5-big', 'id-big') });
      const plan = planPush(
        [local('popka/big.bin', 'big'), local('jopka/big.bin', 'big')],
        state,
        [remote('popka/big.bin', 'md5-big', 'id-big')],
        PLAIN,
      );

      expect(plan.actions).toEqual([
        { type: 'upload', path: 'jopka/big.bin', encrypt: false },
        { type: 'skip', path: 'popka/big.bin', reason: 'unchanged' },
      ]);
    });

    it('gives one Drive copy to one destination and uploads the rest', () => {
      const state = index({ 'old.bin': entry('same', 'md5-s', 'id-s') });
      const plan = planPush(
        [local('a.bin', 'same'), local('b.bin', 'same')],
        state,
        [remote('old.bin', 'md5-s', 'id-s')],
        PLAIN,
      );

      expect(plan.actions).toEqual([
        { type: 'move-remote', path: 'a.bin', from: 'old.bin', fileId: 'id-s' },
        { type: 'upload', path: 'b.bin', encrypt: false },
      ]);
    });

    it('leaves a file another device rewrote to the conflict rules', () => {
      const state = index({ 'old.bin': entry('big', 'md5-mine', 'id-big') });
      const plan = planPush(
        [local('new.bin', 'big')],
        state,
        [remote('old.bin', 'md5-theirs', 'id-big')],
        PLAIN,
      );

      expect(plan.actions).toEqual([
        { type: 'upload', path: 'new.bin', encrypt: false },
        { type: 'skip', path: 'old.bin', reason: 'deleted-locally' },
      ]);
    });

    it('uploads rather than renaming when the destination wants encryption', () => {
      const state = index({ 'plain/note.md': entry('text', 'md5-t', 'id-t') });
      const plan = planPush(
        [local('secret/note.md', 'text')],
        state,
        [remote('plain/note.md', 'md5-t', 'id-t')],
        { ...PLAIN, encryptionEnabled: true, encryptedPrefixes: ['secret/'] },
      );

      expect(plan.actions).toEqual([
        { type: 'upload', path: 'secret/note.md', encrypt: true },
        { type: 'skip', path: 'plain/note.md', reason: 'deleted-locally' },
      ]);
    });

    it('renames an encrypted file that moved within the encrypted zone', () => {
      const state = index({ 'secret/a.md': entry('text', 'md5-t', 'id-t') });
      const sealed = { ...remote('secret/a.md', 'md5-t', 'id-t'), encryptedFlag: true };
      const plan = planPush([local('secret/b.md', 'text')], state, [sealed], {
        ...PLAIN,
        encryptionEnabled: true,
        encryptedPrefixes: ['secret/'],
      });

      expect(plan.actions).toEqual([
        { type: 'move-remote', path: 'secret/b.md', from: 'secret/a.md', fileId: 'id-t' },
      ]);
    });

    it('uploads when Drive says the stored bytes are not in the state the path wants', () => {
      const state = index({ 'secret/a.md': entry('text', 'md5-t', 'id-t') });
      // The rules say encrypted, the file on Drive is not. Renaming would leave
      // a plaintext copy sitting under an encrypted path.
      const plan = planPush(
        [local('secret/b.md', 'text')],
        state,
        [remote('secret/a.md', 'md5-t', 'id-t')],
        { ...PLAIN, encryptionEnabled: true, encryptedPrefixes: ['secret/'] },
      );

      expect(plan.actions).toEqual([
        { type: 'upload', path: 'secret/b.md', encrypt: true },
        { type: 'skip', path: 'secret/a.md', reason: 'deleted-locally' },
      ]);
    });

    it('does not move a file out of an excluded folder', () => {
      const state = index({ 'bin/tool.exe': entry('t', 'md5-t', 'id-t') });
      const plan = planPush(
        [local('kept/tool.exe', 't')],
        state,
        [remote('bin/tool.exe', 'md5-t', 'id-t')],
        excluding('bin/'),
      );

      expect(plan.actions).toEqual([
        { type: 'upload', path: 'kept/tool.exe', encrypt: false },
        { type: 'skip', path: 'bin/tool.exe', reason: 'excluded' },
      ]);
    });

    it('uploads when Drive has no copy of the vanished path to rename', () => {
      const state = index({ 'old.bin': entry('big', 'md5-big', 'id-big') });
      const plan = planPush([local('new.bin', 'big')], state, [], PLAIN);

      expect(plan.actions).toEqual([{ type: 'upload', path: 'new.bin', encrypt: false }]);
      expect(plan.forget).toEqual(['old.bin']);
    });

    it('uploads a moved file whose contents also changed', () => {
      const state = index({ 'old.bin': entry('before', 'md5-b', 'id-b') });
      const plan = planPush(
        [local('new.bin', 'after')],
        state,
        [remote('old.bin', 'md5-b', 'id-b')],
        PLAIN,
      );

      expect(plan.actions).toEqual([
        { type: 'upload', path: 'new.bin', encrypt: false },
        { type: 'skip', path: 'old.bin', reason: 'deleted-locally' },
      ]);
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
    const plan = planPull(
      [remote('a.md'), remote('a.md'), remote('a.md')],
      [local('a.md')],
      index({}),
    );
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

  describe('names that collide only on a case-insensitive filesystem', () => {
    it('does not write over a local file that differs only in case', () => {
      // APFS, NTFS and the exFAT of an SD card treat these as one file, so
      // writing note.md here would destroy Note.md. Drive kept them apart.
      const plan = planPull([remote('note.md')], [local('Note.md')], index({}));
      expect(plan.actions).toEqual([
        {
          type: 'rename-on-collision',
          path: 'note.md',
          fileId: 'id-note.md',
          writeTo: 'note (from drive).md',
        },
      ]);
    });

    it('does not reuse a collision name that differs only in case', () => {
      const plan = planPull(
        [remote('note.md')],
        [local('Note.md'), local('NOTE (from drive).md')],
        index({}),
      );
      expect(
        plan.actions.map((action) => (action.type === 'skip' ? null : action.writeTo)),
      ).toEqual(['note (from drive 2).md']);
    });

    it('still recognises an exact path as unchanged', () => {
      const plan = planPull(
        [remote('note.md', 'md5-a')],
        [local('note.md', 'x')],
        index({ 'note.md': entry('x', 'md5-a') }),
      );
      expect(plan.actions).toEqual([
        { type: 'skip', path: 'note.md', reason: 'already-identical' },
      ]);
    });
  });

  it('treats the two Unicode spellings of one name as one path', () => {
    // macOS hands back NFD, Windows NFC. Left alone, the same note arrives as
    // two files and every push after that is a conflict.
    // Spelled with escapes so the test does not depend on how this file was saved.
    const nfd = 'e\u0301.md';
    const nfc = '\u00e9.md';
    expect(nfd).not.toBe(nfc);

    const plan = planPull([remote(nfd)], [local(nfc)], index({}));
    expect(plan.actions).toEqual([
      {
        type: 'rename-on-collision',
        path: nfc,
        fileId: `id-${nfd}`,
        writeTo: '\u00e9 (from drive).md',
      },
    ]);
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
