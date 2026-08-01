import { describe, expect, it } from 'vitest';

import { describeRules, isRuleEnabled, ruleText, setRuleEnabled } from '../src/core/rule-stats';
import type { RuleSourceLines } from '../src/core/rule-stats';
import type { VaultFileStat } from '../src/types';
import { vaultPath } from '../src/types';

function stat(path: string, size = 100): VaultFileStat {
  return { path: vaultPath(path), mtime: 0, size };
}

const VAULT: readonly VaultFileStat[] = [
  stat('Notes/one.md', 10),
  stat('Notes/two.md', 20),
  stat('media/clip.mp4', 1_000),
  stat('media/other.mp4', 2_000),
  stat('media/cover.png', 30),
];

function settings(...lines: readonly string[]): RuleSourceLines[] {
  return [{ source: 'settings', lines }];
}

describe('isRuleEnabled', () => {
  it('reads a commented-out line as switched off', () => {
    expect(isRuleEnabled('*.mp4')).toBe(true);
    expect(isRuleEnabled('# *.mp4')).toBe(false);
    expect(isRuleEnabled('  #*.mp4')).toBe(false);
  });

  it('leaves an escaped hash alone — that is a file name, not a comment', () => {
    expect(isRuleEnabled('\\#draft.md')).toBe(true);
  });
});

describe('setRuleEnabled', () => {
  it('goes off and back on without losing the rule', () => {
    const off = setRuleEnabled('media/**', false);
    expect(off).toBe('# media/**');
    expect(setRuleEnabled(off, true)).toBe('media/**');
  });

  it('does nothing to a line that carries no rule', () => {
    expect(setRuleEnabled('#', false)).toBe('#');
  });

  it('leaves the pattern of an escaped hash intact', () => {
    expect(ruleText('\\#draft.md')).toBe('\\#draft.md');
  });
});

describe('describeRules', () => {
  it('counts what each rule catches on its own', () => {
    const rules = describeRules(settings('*.mp4', 'Notes/'), VAULT);

    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({
      pattern: '*.mp4',
      source: 'settings',
      position: 0,
      enabled: true,
      negated: false,
      matched: 2,
      bytes: 3_000,
    });
    expect(rules[1]).toMatchObject({ pattern: 'Notes/', matched: 2, bytes: 30 });
  });

  it('still counts a rule that is switched off, so the toggle can say what it costs', () => {
    const [rule] = describeRules(settings('# *.mp4'), VAULT);
    expect(rule).toMatchObject({ pattern: '*.mp4', enabled: false, matched: 2 });
  });

  it('counts what a negated rule reaches rather than what it excludes', () => {
    // Written as an exclusion it would answer zero, because a `!` line on its
    // own excludes nothing.
    const [rule] = describeRules(settings('!media/clip.mp4'), VAULT);
    expect(rule).toMatchObject({ negated: true, matched: 1, bytes: 1_000 });
  });

  it('drops blank lines and lines that carry no pattern', () => {
    expect(describeRules(settings('', '   ', '#'), VAULT)).toEqual([]);
  });

  it('keeps each source in its own numbering, gitignore first', () => {
    const rules = describeRules(
      [
        { source: 'gitignore', lines: ['media/'] },
        { source: 'settings', lines: ['*.png'] },
      ],
      VAULT,
    );

    expect(rules.map((rule) => [rule.source, rule.position, rule.matched])).toEqual([
      ['gitignore', 0, 3],
      ['settings', 0, 1],
    ]);
  });

  it('numbers a rule by its place in the stored list, comments included', () => {
    // The position is what an edit writes back to, so a commented-out line above
    // must not shift the ones below it.
    const rules = describeRules(settings('# off.md', 'media/'), VAULT);
    expect(rules.map((rule) => rule.position)).toEqual([0, 1]);
  });
});
