import { describe, expect, it } from 'vitest';

import { decodePath, encodePath } from '../src/core/path-codec';
import { KEYCHECK_NAME } from '../src/core/container';
import { vaultPath } from '../src/types';

const PATHS = [
  'note.md',
  'folder/note.md',
  'a/b/c/d/deeply nested note.md',
  'Заметки/Привет мир.md',
  'emoji/🔐 secrets 🌍.md',
  'attachments/screenshot 2026-08-01 at 12.34.56.png',
  'weird/name with + and / are impossible but ünïcode is not.md',
  'no-extension',
  '.hidden-but-legal.md',
];

describe('encodePath', () => {
  it('produces names Drive accepts: base64url, no padding', () => {
    for (const path of PATHS) {
      const name = encodePath(vaultPath(path));
      expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(name).not.toContain('=');
    }
  });

  it('is stable for the same input', () => {
    expect(encodePath(vaultPath('folder/note.md'))).toBe(encodePath(vaultPath('folder/note.md')));
  });

  it('gives different names to different paths', () => {
    const names = new Set(PATHS.map((path) => encodePath(vaultPath(path))));
    expect(names.size).toBe(PATHS.length);
  });
});

describe('decodePath', () => {
  it('round-trips every path shape', () => {
    for (const path of PATHS) {
      const decoded = decodePath(encodePath(vaultPath(path)));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) continue;
      expect(decoded.value).toBe(path);
    }
  });

  it('rejects the keycheck file, which is not an encoded path', () => {
    expect(decodePath(KEYCHECK_NAME).ok).toBe(false);
  });

  it('rejects names outside the base64url alphabet', () => {
    expect(decodePath('not base64!').ok).toBe(false);
    expect(decodePath('has+plus').ok).toBe(false);
    expect(decodePath('has/slash').ok).toBe(false);
    expect(decodePath('').ok).toBe(false);
  });

  it('rejects bytes that are not valid utf-8', () => {
    // 0xff is never a legal utf-8 lead byte.
    expect(decodePath('_____w').ok).toBe(false);
  });

  it('decodes an NFD name to the same path as its NFC twin', () => {
    // A note written on a Mac goes up under an NFD name; the same note on a PC
    // is NFC. Both have to come back as one path or the vault gets two of it.
    const nfd = 'Journal/e\u0301t\u00e9.md';
    const nfc = 'Journal/\u00e9t\u00e9.md';

    const fromMac = decodePath(Buffer.from(nfd, 'utf8').toString('base64url'));
    expect(fromMac.ok && fromMac.value).toBe(nfc);
    expect(encodePath(vaultPath(nfd))).toBe(encodePath(vaultPath(nfc)));
  });

  it('refuses paths that would escape the vault', () => {
    // These are well-formed base64url of hostile paths, so only the path rules
    // stop them. A Drive folder is shared storage; its names are not trusted.
    const hostile = ['../outside.md', '/etc/passwd', 'a/../../b.md', 'a//b.md', './x.md'];
    for (const path of hostile) {
      const name = Buffer.from(path, 'utf8').toString('base64url');
      const decoded = decodePath(name);
      expect(decoded.ok, `${path} should be rejected`).toBe(false);
    }
  });
});
