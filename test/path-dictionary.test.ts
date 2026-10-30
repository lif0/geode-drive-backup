import { describe, expect, it } from 'vitest';
import {
  addDictionaryRule,
  emptyDictionary,
  expandPath,
  mergeDictionaries,
  readDictionary,
  substitutePath,
} from '../src/core/path-dictionary';
import type { PathDictionary } from '../src/core/path-dictionary';
import { checkEncodedPath, decodePath, encodePath } from '../src/core/path-codec';
import { migrateSettings } from '../src/settings';
import { vaultPath } from '../src/types';

const dictionary: PathDictionary = {
  version: 1,
  rules: [
    { id: 1, text: 'Data Structures', enabled: true },
    { id: 2, text: 'algocode.io', enabled: true },
    { id: 3, text: 'Data', enabled: true },
    { id: 4, text: 'Пример {1}', enabled: true },
  ],
};

describe('literal replacement format', () => {
  it('uses the longest match at each position, independent of rule order', () => {
    const path = 'Data Structures & Algorithms/algocode.io/algorithms/Data.md';
    const expected = '{1} & Algorithms/{2}/algorithms/{3}.md';
    expect(substitutePath(path, dictionary)).toBe(expected);
    expect(substitutePath(path, { ...dictionary, rules: [...dictionary.rules].reverse() })).toBe(
      expected,
    );
    expect(expandPath(expected, dictionary)).toEqual({ ok: true, value: path });
  });

  it('matches case-sensitively and treats punctuation as literal text', () => {
    expect(substitutePath('data/algocodeXio/algocode.io', dictionary)).toBe('data/algocodeXio/{2}');
  });

  it('does not interpret inserted values or tokens recursively', () => {
    expect(substitutePath('Пример {1}.md', dictionary)).toBe('{4}.md');
    expect(expandPath('{4}.md', dictionary)).toEqual({ ok: true, value: 'Пример {1}.md' });
    const rules: PathDictionary = {
      version: 1,
      rules: [
        { id: 1, text: 'Data', enabled: true },
        { id: 2, text: '{1}', enabled: true },
      ],
    };
    expect(substitutePath('Data/{1}', rules)).toBe('{1}/{2}');
    expect(expandPath('{1}/{2}', rules)).toEqual({ ok: true, value: 'Data/{1}' });
  });

  it.each([
    '{1}',
    '{{1}}',
    '{}',
    '}',
    '{',
    '{{{Data}}}',
    '{X}',
    'Data{1}Пример {1}',
    '🔐/е\u0301/�',
  ])('round-trips literal braces and Unicode: %s', (name) => {
    const path = vaultPath(`folder/${name}.md`);
    expect(decodePath(encodePath(path, dictionary), dictionary)).toEqual({ ok: true, value: path });
  });

  it('round-trips combinations of braces, matches and emoji', () => {
    const fragments = ['{', '}', '{1}', 'Data', 'Data Structures', 'Пример {1}', '🔑', 'abc'];
    for (const a of fragments)
      for (const b of fragments)
        for (const c of fragments) {
          const path = vaultPath(`notes/${a}${b}${c}.md`);
          expect(decodePath(encodePath(path, dictionary), dictionary)).toEqual({
            ok: true,
            value: path,
          });
        }
  });

  it.each(['{0}', '{01}', '{999}', '{1', '}', '{X}', '{-1}', '{1.0}'])(
    'rejects malformed or unknown tokens: %s',
    (text) => {
      expect(expandPath(text, dictionary).ok).toBe(false);
    },
  );

  it('disabled rules still decode old names and additions do not invalidate them', () => {
    const path = vaultPath('Data Structures/note.md');
    const old = encodePath(path, { version: 1, rules: [{ id: 3, text: 'Data', enabled: true }] });
    const disabled = {
      ...dictionary,
      rules: dictionary.rules.map((rule) => ({ ...rule, enabled: false })),
    };
    expect(decodePath(old, dictionary)).toEqual({ ok: true, value: path });
    expect(decodePath(old, disabled)).toEqual({ ok: true, value: path });
    expect(encodePath(path, disabled)).not.toBe(encodePath(path, dictionary));
  });

  it('refuses dangerous paths produced by a valid token', () => {
    for (const text of ['../outside', '/etc/passwd', 'C:/outside', 'a\\b', 'a//b']) {
      const rules: PathDictionary = { version: 1, rules: [{ id: 1, text, enabled: true }] };
      expect(decodePath(Buffer.from('{1}').toString('base64url'), rules).ok).toBe(false);
    }
  });

  it('preflights long names and permits a rule that makes them fit', () => {
    const folder = 'Длинная папка '.repeat(25);
    const path = vaultPath(`${folder}/note.md`);
    expect(checkEncodedPath(path, emptyDictionary()).ok).toBe(false);
    const rules: PathDictionary = { version: 1, rules: [{ id: 1, text: folder, enabled: true }] };
    expect(checkEncodedPath(path, rules).ok).toBe(true);
  });

  it('rejects noncanonical base64 and unsupported formats', () => {
    expect(decodePath('Zh').ok).toBe(false);
    expect(decodePath('d2.Zg').ok).toBe(false);
    expect(decodePath('Zg==').ok).toBe(false);
    expect(decodePath('_w').ok).toBe(false);
  });
});

describe('append-only dictionary', () => {
  it('adds IDs after the highest existing one, even if disabled', () => {
    const current: PathDictionary = { version: 1, rules: [{ id: 8, text: 'old', enabled: false }] };
    const added = addDictionaryRule(current, 'new');
    expect(added.ok && added.value.rules.map((rule) => rule.id)).toEqual([8, 9]);
  });

  it('retains remote-only rules and local enable preferences', () => {
    const local: PathDictionary = {
      version: 1,
      rules: [{ id: 1, text: 'Data Structures', enabled: false }],
    };
    const merged = mergeDictionaries(local, dictionary);
    expect(merged.ok && merged.value.rules).toHaveLength(4);
    expect(merged.ok && merged.value.rules[0]?.enabled).toBe(false);
  });

  it('refuses reassigned IDs and duplicate text under another ID', () => {
    expect(
      mergeDictionaries(
        { version: 1, rules: [{ id: 1, text: 'Other', enabled: true }] },
        dictionary,
      ).ok,
    ).toBe(false);
    expect(
      mergeDictionaries({ version: 1, rules: [{ id: 9, text: 'Data', enabled: true }] }, dictionary)
        .ok,
    ).toBe(false);
  });

  it.each([
    null,
    {},
    { version: 2, rules: [] },
    { version: 1, rules: [{ id: 0, text: 'x', enabled: true }] },
    { version: 1, rules: [{ id: 1, text: '', enabled: true }] },
    { version: 1, rules: [{ id: 1.5, text: 'x', enabled: true }] },
    { version: 1, rules: [{ id: 1, text: 'x', enabled: 'yes' }] },
    { version: 1, rules: [{ id: 1, text: 'e\u0301', enabled: true }] },
  ])('rejects invalid stored dictionaries: %j', (value) => {
    expect(readDictionary(value).ok).toBe(false);
  });

  it('normalizes newly entered rules and rejects empty or duplicate fragments', () => {
    const added = addDictionaryRule(emptyDictionary(), 'e\u0301');
    expect(added.ok && added.value.rules[0]?.text).toBe('é');
    expect(addDictionaryRule(dictionary, '').ok).toBe(false);
    expect(addDictionaryRule(dictionary, 'Data').ok).toBe(false);
  });

  it('keeps a malformed local dictionary blocked across settings saves', () => {
    const settings = migrateSettings({ pathDictionary: { version: 999 } });
    expect(settings.pathDictionaryError).not.toBeNull();
    expect(migrateSettings(settings).pathDictionaryError).not.toBeNull();
    expect(migrateSettings({ pathDictionary: null }).pathDictionaryError).not.toBeNull();
    expect(
      readDictionary({ version: 1, rules: [{ id: 1, text: '\ud800', enabled: true }] }).ok,
    ).toBe(false);
  });
});
