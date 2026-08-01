import { describe, expect, it } from 'vitest';

import type { BackupState } from '../src/core/backup-state';
import { rollUpFolders } from '../src/core/backup-state';

function files(pairs: Record<string, BackupState>): Map<string, BackupState> {
  return new Map(Object.entries(pairs));
}

describe('rollUpFolders', () => {
  it('keeps every file it was given', () => {
    const states = rollUpFolders(files({ 'a/note.md': 'backed-up' }));
    expect(states.get('a/note.md')).toBe('backed-up');
  });

  it('adds an entry for every folder above a file', () => {
    const states = rollUpFolders(files({ 'a/b/c/note.md': 'pending' }));
    expect(states.get('a')).toBe('pending');
    expect(states.get('a/b')).toBe('pending');
    expect(states.get('a/b/c')).toBe('pending');
  });

  it('says nothing about a folder with nothing in it', () => {
    // Obsidian's file list has no folders, only paths, so a folder Geode has
    // never seen a file in simply gets no dot.
    const states = rollUpFolders(files({ 'a/note.md': 'backed-up' }));
    expect(states.has('b')).toBe(false);
  });

  it('lets one waiting file make the whole folder wait', () => {
    // The reassuring answer has to be earned by everything below it: a green
    // folder holding an unsaved note is exactly the lie this must not tell.
    const states = rollUpFolders(
      files({
        'Journal/old.md': 'backed-up',
        'Journal/new.md': 'pending',
        'Journal/junk.log': 'excluded',
      }),
    );
    expect(states.get('Journal')).toBe('pending');
  });

  it('prefers backed-up to excluded', () => {
    const states = rollUpFolders(
      files({ 'mixed/note.md': 'backed-up', 'mixed/build.exe': 'excluded' }),
    );
    expect(states.get('mixed')).toBe('backed-up');
  });

  it('calls a folder excluded only when everything under it is', () => {
    const states = rollUpFolders(files({ 'bin/a.exe': 'excluded', 'bin/deep/b.dll': 'excluded' }));
    expect(states.get('bin')).toBe('excluded');
    expect(states.get('bin/deep')).toBe('excluded');
  });

  it('does not let sibling folders bleed into each other', () => {
    const states = rollUpFolders(files({ 'a/note.md': 'pending', 'b/note.md': 'backed-up' }));
    expect(states.get('a')).toBe('pending');
    expect(states.get('b')).toBe('backed-up');
  });

  it('leaves a root-level file without inventing a folder', () => {
    const states = rollUpFolders(files({ 'note.md': 'pending' }));
    expect([...states.keys()]).toEqual(['note.md']);
  });
});
