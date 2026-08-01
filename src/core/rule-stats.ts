/**
 * The exclusion rules as a list a person can read, one line at a time.
 *
 * The rules themselves compile to one matcher and answer one question — is this
 * path excluded — which is what a push needs and useless for deciding whether a
 * rule was a good idea. So each line is also compiled on its own and run over
 * the vault, and what comes back is the number that settles it: `*.mp4` keeping
 * out 142 files and a gigabyte is doing its job, `test/` keeping out 300 is
 * about to lose someone their notes.
 *
 * A rule is switched off by commenting it out rather than deleting it, because
 * the interesting thing about an exclusion is usually what it was hiding, and
 * that is a question you ask after turning it off.
 */

import { isIgnored, parseIgnore } from './ignore';
import type { VaultFileStat } from '../types';

/** Where a rule was written. Only the settings list can be edited from the panel. */
export type RuleSource = 'gitignore' | 'settings';

/** One rule line, with what it does to this vault. */
export interface RuleLine {
  /** The line exactly as stored, including the `#` when it is switched off. */
  readonly text: string;
  /** The rule itself: `text` with the switched-off marker taken back off. */
  readonly pattern: string;
  readonly source: RuleSource;
  /** Position within its own source list, which is how an edit finds it again. */
  readonly position: number;
  readonly enabled: boolean;
  /** Written with `!`: brings back files an earlier rule excluded. */
  readonly negated: boolean;
  /**
   * Files this line alone catches — counted even when it is switched off, so the
   * toggle can say what turning it on would cost before it is turned on.
   */
  readonly matched: number;
  readonly bytes: number;
}

/** A list of rule lines and where they came from, in the order they apply. */
export interface RuleSourceLines {
  readonly source: RuleSource;
  readonly lines: readonly string[];
}

/** True if the line is commented out — our own way of switching a rule off. */
export function isRuleEnabled(line: string): boolean {
  return !line.trim().startsWith('#');
}

/**
 * The rule without its comment marker.
 *
 * `\#` is left alone: in `.gitignore` syntax that is an escaped hash, the way to
 * name a file that really does begin with one.
 */
export function ruleText(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('#')) return trimmed;
  return trimmed.slice(1).trim();
}

/** The line rewritten to be on or off, ready to be stored again. */
export function setRuleEnabled(line: string, enabled: boolean): string {
  const pattern = ruleText(line);
  if (pattern.length === 0) return line;
  return enabled ? pattern : `# ${pattern}`;
}

/**
 * Runs every rule over the vault on its own.
 *
 * Costs one regular expression per rule per file, so it belongs on a tab being
 * opened rather than on a repaint. Lines that carry no rule — blank ones, and
 * comments that were always comments — are dropped rather than shown as rules
 * that match nothing.
 */
export function describeRules(
  sources: readonly RuleSourceLines[],
  files: readonly VaultFileStat[],
): RuleLine[] {
  const described: RuleLine[] = [];

  for (const { source, lines } of sources) {
    for (const [position, text] of lines.entries()) {
      const pattern = ruleText(text);
      if (pattern.length === 0) continue;

      const negated = pattern.startsWith('!');
      // A negated line excludes nothing by itself, so counting it as written
      // would always answer zero. What it is worth knowing is how many files it
      // reaches — the ones it is there to bring back.
      const counted = countMatches(negated ? pattern.slice(1) : pattern, files);

      described.push({
        text,
        pattern,
        source,
        position,
        enabled: isRuleEnabled(text),
        negated,
        matched: counted.files,
        bytes: counted.bytes,
      });
    }
  }

  return described;
}

function countMatches(
  pattern: string,
  files: readonly VaultFileStat[],
): { files: number; bytes: number } {
  const rules = parseIgnore(pattern);
  if (rules.rules.length === 0) return { files: 0, bytes: 0 };

  let matched = 0;
  let bytes = 0;
  for (const file of files) {
    if (!isIgnored(rules, file.path)) continue;
    matched += 1;
    bytes += file.size;
  }
  return { files: matched, bytes };
}
