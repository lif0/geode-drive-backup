import { describe, expect, it } from 'vitest';

import { formatBytes, formatDuration, formatRate } from '../src/core/bytes';

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

describe('formatRate', () => {
  it('reads as a speed', () => {
    expect(formatRate(1024 * 1024)).toBe('1.0 MB/s');
    expect(formatRate(512)).toBe('512 B/s');
  });

  it('says nothing rather than zero when there is no measurement yet', () => {
    expect(formatRate(0)).toBe('—');
    expect(formatRate(Number.NaN)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('stays coarse, because the number is an extrapolation', () => {
    expect(formatDuration(0.2)).toBe('1s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(90)).toBe('2 min');
    expect(formatDuration(60 * 24)).toBe('24 min');
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(3600 + 12 * 60)).toBe('1 h 12 min');
  });

  it('refuses to guess from nonsense', () => {
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(-5)).toBe('—');
  });
});
