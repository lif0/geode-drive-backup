import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DICTIONARY_NAME, serializeDictionary } from '../src/core/path-dictionary';
import type { PathDictionary } from '../src/core/path-dictionary';
import { encodePath } from '../src/core/path-codec';
import { vaultPath } from '../src/types';

const temporary: string[] = [];
const tool = resolve('tools/decrypt.mjs');
const dictionary: PathDictionary = {
  version: 1,
  rules: [
    { id: 1, text: 'Data Structures', enabled: true },
    { id: 2, text: 'Data', enabled: true },
    { id: 3, text: 'Пример {1}', enabled: true },
  ],
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'geode-dictionary-'));
  temporary.push(root);
  const input = join(root, 'download');
  const output = join(root, 'restored');
  mkdirSync(input);
  mkdirSync(join(input, 'objects'));
  writeFileSync(join(input, DICTIONARY_NAME), serializeDictionary(dictionary));
  return { input, output };
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('standalone dictionary recovery', () => {
  it('requires objects instead of reporting an incomplete download as restored', () => {
    const { input, output } = fixture();
    rmSync(join(input, 'objects'), { recursive: true });
    const result = spawnSync(process.execPath, [tool, '--dir', input, '--out', output], {
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('objects directory');
  });

  it('rejects mixed flat and objects storage', () => {
    const { input, output } = fixture();
    writeFileSync(join(input, encodePath(vaultPath('note.md'))), 'root data');
    const result = spawnSync(process.execPath, [tool, '--dir', input, '--out', output], {
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Flat or mixed');
  });
  it('restores plugin-encoded names, literal braces and disabled rules without Obsidian', () => {
    const { input, output } = fixture();
    const paths = ['Data Structures/Data/заметка {1}.md', 'Пример {1}/🔐.md', '{{}}/normal.md'];
    for (const path of paths)
      writeFileSync(join(input, 'objects', encodePath(vaultPath(path), dictionary)), path);
    writeFileSync(
      join(input, DICTIONARY_NAME),
      serializeDictionary({
        ...dictionary,
        rules: dictionary.rules.map((rule) => ({ ...rule, enabled: false })),
      }),
    );
    execFileSync(process.execPath, [tool, '--dir', input, '--out', output], { stdio: 'pipe' });
    for (const path of paths) expect(readFileSync(join(output, path), 'utf8')).toBe(path);
  });

  it('refuses a missing dictionary instead of guessing paths', () => {
    const { input, output } = fixture();
    rmSync(join(input, DICTIONARY_NAME));
    const result = spawnSync(process.execPath, [tool, '--dir', input, '--out', output], {
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Missing __geode_dictionary.json');
  });

  it.each(['{99}.md', '../outside.md', 'C:/outside.md', '{1', 'a//b.md'])(
    'rejects invalid decoded path %s',
    (path) => {
      const { input, output } = fixture();
      writeFileSync(join(input, 'objects', Buffer.from(path).toString('base64url')), 'content');
      const result = spawnSync(process.execPath, [tool, '--dir', input, '--out', output], {
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
    },
  );

  it('refuses to overwrite an existing local file', () => {
    const { input, output } = fixture();
    mkdirSync(output);
    writeFileSync(join(output, 'keep.md'), 'local');
    writeFileSync(join(input, 'objects', encodePath(vaultPath('keep.md'), dictionary)), 'remote');
    const result = spawnSync(process.execPath, [tool, '--dir', input, '--out', output], {
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(output, 'keep.md'), 'utf8')).toBe('local');
  });

  it('rejects two encoded names pointing at the same path', () => {
    const { input, output } = fixture();
    writeFileSync(join(input, 'objects', encodePath(vaultPath('Data/a.md'), dictionary)), 'one');
    writeFileSync(join(input, 'objects', encodePath(vaultPath('Data/a.md'))), 'two');
    const result = spawnSync(process.execPath, [tool, '--dir', input, '--out', output], {
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Duplicate');
  });
});
