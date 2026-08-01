import { describe, expect, it } from 'vitest';

import { NO_IGNORE_RULES, isIgnored, parseIgnore } from '../src/core/ignore';

/** Reads as `excluded('bin/')('src/bin/x.dll')` → true. */
function excluded(...lines: string[]): (path: string) => boolean {
  const rules = parseIgnore(lines.join('\n'));
  return (path: string) => isIgnored(rules, path);
}

describe('parseIgnore', () => {
  it('excludes nothing when there are no rules', () => {
    expect(isIgnored(NO_IGNORE_RULES, 'anything.md')).toBe(false);
    expect(excluded('')('anything.md')).toBe(false);
  });

  it('ignores blank lines and comments', () => {
    const hit = excluded('', '   ', '# bin/', 'logs/');
    expect(hit('bin/tool.exe')).toBe(false);
    expect(hit('logs/today.txt')).toBe(true);
  });

  it('takes a literal # or ! after a backslash', () => {
    expect(excluded('\\#notes.md')('#notes.md')).toBe(true);
    expect(excluded('\\!urgent.md')('!urgent.md')).toBe(true);
  });
});

describe('matching', () => {
  it('matches a slashless pattern at any depth', () => {
    const hit = excluded('Thumbs.db');
    expect(hit('Thumbs.db')).toBe(true);
    expect(hit('Notes/deep/Thumbs.db')).toBe(true);
  });

  it('pins a pattern with a leading slash to the vault root', () => {
    const hit = excluded('/Drafts');
    expect(hit('Drafts')).toBe(true);
    expect(hit('Notes/Drafts')).toBe(false);
  });

  it('pins a pattern that contains a slash', () => {
    const hit = excluded('.vscode/*.log');
    expect(hit('.vscode/debug.log')).toBe(true);
    expect(hit('Notes/.vscode/debug.log')).toBe(false);
    expect(hit('.vscode/nested/debug.log')).toBe(false);
  });

  it('keeps * inside one path segment', () => {
    const hit = excluded('*.mp4');
    expect(hit('clip.mp4')).toBe(true);
    expect(hit('Media/clip.mp4')).toBe(true);
    expect(hit('clip.mp4.md')).toBe(false);
  });

  it('lets ** cross path segments', () => {
    const hit = excluded('**/.idea/**/*.iml');
    expect(hit('.idea/a.iml')).toBe(true);
    expect(hit('Project/.idea/modules/a.iml')).toBe(true);
    expect(hit('Project/a.iml')).toBe(false);
  });

  it('lets **/ match zero directories', () => {
    const hit = excluded('**/build');
    expect(hit('build')).toBe(true);
    expect(hit('a/b/build')).toBe(true);
  });

  it('matches one character with ?', () => {
    const hit = excluded('draft?.md');
    expect(hit('draft1.md')).toBe(true);
    expect(hit('draft.md')).toBe(false);
    expect(hit('draft12.md')).toBe(false);
  });

  it('supports character classes and their negation', () => {
    expect(excluded('[Bb]in/')('Bin/tool.exe')).toBe(true);
    expect(excluded('[Bb]in/')('bin/tool.exe')).toBe(true);
    expect(excluded('[Bb]in/')('din/tool.exe')).toBe(false);
    expect(excluded('note[!0-9].md')('notea.md')).toBe(true);
    expect(excluded('note[!0-9].md')('note1.md')).toBe(false);
  });

  it('takes an unclosed bracket literally', () => {
    expect(excluded('a[b.md')('a[b.md')).toBe(true);
  });

  it('does not let a pattern match a partial segment', () => {
    const hit = excluded('bin');
    expect(hit('bin/tool.exe')).toBe(true);
    expect(hit('binaries/tool.exe')).toBe(false);
  });
});

describe('directory rules', () => {
  it('excludes everything under a directory pattern', () => {
    const hit = excluded('logs/');
    expect(hit('logs/today.txt')).toBe(true);
    expect(hit('logs/2026/08/today.txt')).toBe(true);
    expect(hit('Notes/logs/today.txt')).toBe(true);
  });

  it('does not match a file of the same name', () => {
    const hit = excluded('logs/');
    expect(hit('logs')).toBe(false);
    expect(hit('Notes/logs')).toBe(false);
  });

  it('matches a file of the same name without the trailing slash', () => {
    expect(excluded('logs')('logs')).toBe(true);
  });
});

describe('negation', () => {
  it('re-includes a file the previous line excluded', () => {
    const hit = excluded('*.mp4', '!Notes/demo.mp4');
    expect(hit('Media/clip.mp4')).toBe(true);
    expect(hit('Notes/demo.mp4')).toBe(false);
  });

  it('lets the last matching line win', () => {
    expect(excluded('!keep.md', 'keep.md')('keep.md')).toBe(true);
    expect(excluded('keep.md', '!keep.md')('keep.md')).toBe(false);
  });

  it('cannot reach inside an excluded directory, as in git', () => {
    // git never descends into an excluded directory, so there is nothing there
    // for a later line to re-include. Surprising, and worth pinning down.
    const hit = excluded('Programs/', '!Programs/notes.md');
    expect(hit('Programs/notes.md')).toBe(true);
  });
});

describe("a real vault's .gitignore", () => {
  // The file this feature was written for, trimmed to the lines that can match
  // something Obsidian actually enumerates: it hides dotfiles and dot-folders,
  // so every `.idea/` and `.vs/` rule is a no-op in a vault regardless.
  const hit = excluded(
    '# User specific',
    '**/.idea/**/workspace.xml',
    '*.suo',
    '*.user',
    '.vs/',
    '[Bb]in/',
    '[Oo]bj/',
    '_UpgradeReport_Files/',
    '[Pp]ackages/',
    'Thumbs.db',
    'Desktop.ini',
    '.DS_Store',
    'test/',
    'bin/',
    'obj/',
    '.idea/',
    '.trash/',
    '.vscode/*.log',
    '*_480p_compressed.mp4',
    'browser/',
    'logs/',
  );

  it('excludes the build output it was written for', () => {
    expect(hit('Projects/app/bin/app.exe')).toBe(true);
    expect(hit('Projects/app/Bin/app.exe')).toBe(true);
    expect(hit('Projects/app/obj/Debug/app.pdb')).toBe(true);
    expect(hit('Packages/thing/lib.dll')).toBe(true);
    expect(hit('solution.suo')).toBe(true);
  });

  it('excludes the junk files', () => {
    expect(hit('Notes/Thumbs.db')).toBe(true);
    expect(hit('Notes/.DS_Store')).toBe(true);
    expect(hit('Desktop.ini')).toBe(true);
    expect(hit('browser/cache/blob')).toBe(true);
    expect(hit('logs/run.txt')).toBe(true);
    expect(hit('Media/lecture_480p_compressed.mp4')).toBe(true);
  });

  it('keeps the notes', () => {
    expect(hit('Journal/2026-08-01.md')).toBe(false);
    expect(hit('Projects/roadmap.md')).toBe(false);
    expect(hit('Media/lecture.mp4')).toBe(false);
    // "binaries" is not "bin", and a note about testing is not a test folder.
    expect(hit('Notes/binaries.md')).toBe(false);
    expect(hit('Notes/testing.md')).toBe(false);
  });

  it('also takes out a folder called test at any depth', () => {
    // Not a bug — git's own rule for a slashless pattern — but the reason the
    // settings tab offers a dry run before anything is left out of a backup.
    expect(hit('test/fixture.json')).toBe(true);
    expect(hit('Notes/test/idea.md')).toBe(true);
  });
});
