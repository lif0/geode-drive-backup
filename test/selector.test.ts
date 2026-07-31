import { describe, expect, it } from 'vitest';

import { formatPrefixList, matchingPrefixes, parsePrefixList, shouldEncrypt } from '../src/core/selector';
import { vaultPath } from '../src/types';

const encrypts = (path: string, prefixes: string[]): boolean =>
  shouldEncrypt(vaultPath(path), prefixes);

describe('shouldEncrypt', () => {
  it('encrypts nothing when no prefixes are configured', () => {
    expect(encrypts('Journal/2026.md', [])).toBe(false);
  });

  it('matches a folder and everything under it', () => {
    expect(encrypts('Journal', ['Journal'])).toBe(true);
    expect(encrypts('Journal/2026.md', ['Journal'])).toBe(true);
    expect(encrypts('Journal/a/b/c.md', ['Journal'])).toBe(true);
  });

  it('treats a trailing slash the same as no trailing slash', () => {
    expect(encrypts('Journal/2026.md', ['Journal/'])).toBe(true);
    expect(encrypts('Journal', ['Journal/'])).toBe(true);
  });

  it('does not match a sibling with a longer name', () => {
    // The whole point of segment-aware matching: Journalism is not in Journal.
    expect(encrypts('Journalism.md', ['Journal'])).toBe(false);
    expect(encrypts('Journalism/notes.md', ['Journal'])).toBe(false);
  });

  it('matches a raw character prefix with a trailing star', () => {
    expect(encrypts('Journalism.md', ['Journal*'])).toBe(true);
    expect(encrypts('Journal/2026.md', ['Journal*'])).toBe(true);
    expect(encrypts('Diary.md', ['Journal*'])).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(encrypts('journal/2026.md', ['Journal'])).toBe(false);
  });

  it('matches if any prefix matches', () => {
    const prefixes = ['Journal', 'Secrets/keys', 'Finance*'];
    expect(encrypts('Secrets/keys/ssh.md', prefixes)).toBe(true);
    expect(encrypts('Finance2026.md', prefixes)).toBe(true);
    expect(encrypts('Secrets/other.md', prefixes)).toBe(false);
    expect(encrypts('Recipes/bread.md', prefixes)).toBe(false);
  });

  it('handles non-ascii prefixes', () => {
    expect(encrypts('Заметки/личное.md', ['Заметки'])).toBe(true);
    expect(encrypts('Другое/личное.md', ['Заметки'])).toBe(false);
  });

  it('treats a star anywhere but the end as a literal character', () => {
    expect(encrypts('a*b/note.md', ['a*b'])).toBe(true);
    expect(encrypts('axb/note.md', ['a*b'])).toBe(false);
  });

  it('ignores an empty prefix rather than encrypting the whole vault', () => {
    expect(encrypts('anything.md', [''])).toBe(false);
    expect(encrypts('anything.md', ['   '])).toBe(false);
  });

  it('does match everything when the prefix is a bare star', () => {
    expect(encrypts('anything.md', ['*'])).toBe(true);
  });

  it('tolerates surrounding whitespace in a prefix', () => {
    expect(encrypts('Journal/2026.md', ['  Journal  '])).toBe(true);
  });
});

describe('matchingPrefixes', () => {
  it('reports every rule responsible for a path', () => {
    const prefixes = ['Journal', 'Jour*', 'Other'];
    expect(matchingPrefixes(vaultPath('Journal/a.md'), prefixes)).toEqual(['Journal', 'Jour*']);
  });

  it('is empty when nothing matches', () => {
    expect(matchingPrefixes(vaultPath('a.md'), ['Journal'])).toEqual([]);
  });
});

describe('parsePrefixList', () => {
  it('splits lines, trims them and drops blanks', () => {
    expect(parsePrefixList('Journal\n\n  Secrets/keys  \n\n')).toEqual(['Journal', 'Secrets/keys']);
  });

  it('drops comment lines', () => {
    expect(parsePrefixList('# everything private\nJournal')).toEqual(['Journal']);
  });

  it('round-trips through formatPrefixList', () => {
    const prefixes = ['Journal', 'Secrets/keys', 'Finance*'];
    expect(parsePrefixList(formatPrefixList(prefixes))).toEqual(prefixes);
  });
});
