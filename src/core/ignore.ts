/**
 * Exclusion rules in `.gitignore` syntax: the paths Geode never uploads.
 *
 * A vault is not only notes. People keep binaries, build output, whole program
 * folders and multi-gigabyte media in there, and none of it belongs in a backup
 * that exists to protect writing. Excluding it saves the upload, and it also
 * saves the read: an excluded file is never opened, so a 2 GB folder stops
 * costing anything on every push.
 *
 * The syntax is git's because the user already knows it and, in a vault that is
 * a repository, already wrote it. What is supported:
 *
 * - `#` comments, blank lines, `\#` and `\!` to escape a leading marker
 * - `!pattern` to re-include; the last matching line wins
 * - `/foo` anchored to the vault root; `foo` matching at any depth
 * - `foo/` matching a directory and everything inside it
 * - `*` and `?` within one path segment, `**` across segments
 * - `[abc]` and `[!a-z]` character classes
 *
 * What is not: nested `.gitignore` files below the vault root — only the root
 * one is read — and `.gitignore`'s deference to files git already tracks, which
 * has no meaning here.
 *
 * Exclusion is a rule about what leaves this device, so it applies to push and
 * not to pull. Excluding a path never deletes its Drive copy either: a file
 * that stops being backed up must not also vanish from the backup.
 */

/** One parsed line. */
interface IgnoreRule {
  /** Written with a leading `!`: re-includes what an earlier line excluded. */
  readonly negated: boolean;
  /** Written with a trailing `/`: matches directories only. */
  readonly directoryOnly: boolean;
  readonly matcher: RegExp;
}

/** Compiled rules, in source order. Later lines override earlier ones. */
export interface IgnoreRules {
  readonly rules: readonly IgnoreRule[];
}

/** Rules that exclude nothing. */
export const NO_IGNORE_RULES: IgnoreRules = { rules: [] };

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;

function escapeLiteral(ch: string): string {
  return REGEX_SPECIAL.test(ch) ? `\\${ch}` : ch;
}

/**
 * Drops trailing whitespace, which git treats as accidental unless escaped.
 *
 * Done by hand rather than with a lookbehind, which not every engine this
 * bundle can land in supports.
 */
function stripTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0) {
    const last = line.charAt(end - 1);
    if (last !== ' ' && last !== '\t') break;
    if (end >= 2 && line.charAt(end - 2) === '\\') break;
    end -= 1;
  }
  return line.slice(0, end);
}

/** Translates a character class, returning null if the bracket never closes. */
function compileClass(pattern: string, start: number): { source: string; next: number } | null {
  let at = start + 1;
  let negated = false;

  if (pattern.charAt(at) === '!' || pattern.charAt(at) === '^') {
    negated = true;
    at += 1;
  }

  let body = '';
  // A `]` in first position is a literal `]`, not the end of the class.
  if (pattern.charAt(at) === ']') {
    body += '\\]';
    at += 1;
  }

  while (at < pattern.length && pattern.charAt(at) !== ']') {
    const ch = pattern.charAt(at);
    body += ch === '\\' || ch === '[' || ch === '^' ? `\\${ch}` : ch;
    at += 1;
  }

  if (at >= pattern.length) return null;
  return { source: `[${negated ? '^' : ''}${body}]`, next: at + 1 };
}

/** Turns a glob into the body of a regular expression. */
function compileGlob(pattern: string): string {
  let source = '';
  let at = 0;

  while (at < pattern.length) {
    const ch = pattern.charAt(at);

    if (ch === '\\') {
      const escaped = pattern.charAt(at + 1);
      source += escaped === '' ? '\\\\' : escapeLiteral(escaped);
      at += 2;
      continue;
    }

    if (ch === '*') {
      if (pattern.charAt(at + 1) === '*') {
        // `**/` swallows its own slash so that it can also match no directory
        // at all: `**/build` has to match a top-level `build` too.
        if (pattern.charAt(at + 2) === '/') {
          source += '(?:.*/)?';
          at += 3;
          continue;
        }
        source += '.*';
        at += 2;
        continue;
      }
      source += '[^/]*';
      at += 1;
      continue;
    }

    if (ch === '?') {
      source += '[^/]';
      at += 1;
      continue;
    }

    if (ch === '[') {
      const compiled = compileClass(pattern, at);
      if (compiled === null) {
        // An unclosed bracket is a literal bracket, as in git.
        source += '\\[';
        at += 1;
        continue;
      }
      source += compiled.source;
      at = compiled.next;
      continue;
    }

    source += escapeLiteral(ch);
    at += 1;
  }

  return source;
}

/** Parses `.gitignore` text — several files' worth, if they are joined by newlines. */
export function parseIgnore(text: string): IgnoreRules {
  const rules: IgnoreRule[] = [];

  for (const raw of text.split('\n')) {
    const line = stripTrailingSpaces(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    if (line.length === 0 || line.startsWith('#')) continue;

    const negated = line.startsWith('!');
    let pattern = negated ? line.slice(1) : line;
    if (pattern.startsWith('\\#') || pattern.startsWith('\\!')) pattern = pattern.slice(1);

    const directoryOnly = pattern.endsWith('/');
    if (directoryOnly) pattern = pattern.slice(0, -1);

    // A slash anywhere but at the end pins the pattern to the vault root.
    // Without one it matches at any depth, which is what makes a bare
    // `node_modules` line work wherever the folder turns up.
    const anchored = pattern.includes('/');
    if (pattern.startsWith('/')) pattern = pattern.slice(1);
    if (pattern.length === 0) continue;

    rules.push({
      negated,
      directoryOnly,
      matcher: new RegExp(`${anchored ? '^' : '^(?:.*/)?'}${compileGlob(pattern)}$`),
    });
  }

  return { rules };
}

function matches(rules: IgnoreRules, candidate: string, isDirectory: boolean): boolean {
  let excluded = false;
  for (const rule of rules.rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    if (!rule.matcher.test(candidate)) continue;
    excluded = !rule.negated;
  }
  return excluded;
}

/**
 * True if `path` is excluded from the backup.
 *
 * Every directory above the file is tested first, top down, because git decides
 * exclusion while walking the tree and never looks inside a directory it has
 * excluded. That is why `!Programs/keep.md` cannot rescue a file under an
 * excluded `Programs/` — and reproducing it here, with nothing but a list of
 * file paths to work from, means checking the ancestors explicitly.
 */
export function isIgnored(rules: IgnoreRules, path: string): boolean {
  if (rules.rules.length === 0) return false;

  const segments = path.split('/');
  for (let depth = 1; depth < segments.length; depth += 1) {
    if (matches(rules, segments.slice(0, depth).join('/'), true)) return true;
  }

  return matches(rules, path, false);
}
