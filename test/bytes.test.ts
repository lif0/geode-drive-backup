import { describe, expect, it } from 'vitest';

import { formatBytes } from '../src/core/bytes';

describe('formatBytes', () => {
  it('leaves whole bytes without a decimal', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('scales by 1024, as every file manager does', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(4.1 * 1024 * 1024)).toBe('4.1 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
  });

  it('stops scaling at the largest unit it knows', () => {
    expect(formatBytes(5 * 1024 ** 5)).toBe('5120.0 TB');
  });

  it('reads a nonsense size as nothing rather than as NaN', () => {
    // The size can come from a Drive listing that omitted it, and a progress
    // bar labelled "NaN MB" is worse than one labelled "0 B".
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});
