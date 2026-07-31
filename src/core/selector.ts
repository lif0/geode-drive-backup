import type { VaultPath } from '../types';

/**
 * Decides which files get encrypted before upload.
 *
 * The rule is deliberately dumb, because a surprising rule here means a file the
 * user believed was encrypted went up in the clear:
 *
 * - `Journal` or `Journal/` matches the folder `Journal` and everything inside
 *   it. It does not match `Journalism.md`.
 * - `Journal*` — one trailing star, and only at the end — matches any path that
 *   literally starts with `Journal`, including `Journalism.md`.
 *
 * There is no other glob syntax. `*` anywhere but the end is treated as a
 * literal character.
 */

/** Turns the settings textarea into a prefix list, dropping blanks and comments. */
export function parsePrefixList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** Renders a prefix list back into textarea contents. */
export function formatPrefixList(prefixes: readonly string[]): string {
  return prefixes.join('\n');
}

function matchesPrefix(path: string, prefix: string): boolean {
  if (prefix.endsWith('*')) {
    return path.startsWith(prefix.slice(0, -1));
  }

  const folder = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (folder.length === 0) return false;

  return path === folder || path.startsWith(`${folder}/`);
}

/**
 * True if `path` should be encrypted before upload.
 *
 * Matching is case-sensitive and operates on the raw path string. Does NOT look
 * at file contents, extensions or size.
 */
export function shouldEncrypt(path: VaultPath, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => matchesPrefix(path, prefix.trim()));
}

/**
 * Every prefix that would encrypt `path`. Used by the settings tab to show the
 * user which rule is responsible for a given file.
 */
export function matchingPrefixes(path: VaultPath, prefixes: readonly string[]): string[] {
  return prefixes.filter((prefix) => matchesPrefix(path, prefix.trim()));
}
