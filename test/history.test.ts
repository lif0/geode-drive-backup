import { describe, expect, it } from 'vitest';

import type { RunRecord } from '../src/core/history';
import {
  appendRun,
  dailyBytes,
  describeRun,
  failureOf,
  formatAgo,
  formatWhen,
  recordOf,
  runTitle,
} from '../src/core/history';
import type { OperationSummary, VaultPath } from '../src/types';
import { cancelledError, networkError, vaultPath } from '../src/types';

function summary(over: Partial<OperationSummary> = {}): OperationSummary {
  return {
    operation: 'push',
    cancelled: false,
    uploaded: 0,
    updated: 0,
    downloaded: 0,
    moved: 0,
    renamed: 0,
    deleted: 0,
    skipped: 0,
    excluded: 0,
    conflicts: [],
    failures: [],
    warnings: [],
    ...over,
  };
}

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    at: 1_000,
    operation: 'push',
    outcome: 'ok',
    files: 0,
    bytes: 0,
    durationMs: 0,
    conflicts: 0,
    failures: 0,
    message: '',
    ...over,
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('recordOf', () => {
  it('counts every file that actually moved', () => {
    const made = recordOf(
      summary({ uploaded: 3, updated: 2, moved: 1, deleted: 4, skipped: 900 }),
      2_048,
      5_000,
      42,
    );

    expect(made).toMatchObject({ at: 42, files: 10, bytes: 2_048, durationMs: 5_000, outcome: 'ok' });
  });

  it('calls a run with failures or conflicts partial', () => {
    const paths: VaultPath[] = [vaultPath('a.md')];
    expect(recordOf(summary({ conflicts: paths }), 0, 0, 1).outcome).toBe('partial');
    expect(
      recordOf(summary({ failures: [{ path: vaultPath('b.md'), message: 'nope' }] }), 0, 0, 1)
        .outcome,
    ).toBe('partial');
  });

  it('calls a stopped run cancelled, whatever else it managed', () => {
    expect(recordOf(summary({ cancelled: true, uploaded: 5 }), 0, 0, 1).outcome).toBe('cancelled');
  });
});

describe('failureOf', () => {
  it('keeps the message and the bytes that did land', () => {
    const made = failureOf('push', networkError('Drive is unreachable.'), 500, 900, 7);
    expect(made).toMatchObject({
      outcome: 'failed',
      bytes: 500,
      message: 'Drive is unreachable.',
      operation: 'push',
    });
  });

  it('files a cancellation as cancelled rather than as a failure', () => {
    expect(failureOf('pull', cancelledError('Stopped.'), 0, 0, 1).outcome).toBe('cancelled');
  });
});

describe('appendRun', () => {
  it('puts the newest run first and never mutates what it was given', () => {
    const history = [record({ at: 1 })];
    const next = appendRun(history, record({ at: 2 }));

    expect(next.map((run) => run.at)).toEqual([2, 1]);
    expect(history).toHaveLength(1);
  });

  it('drops the oldest once the log is full', () => {
    const history = [record({ at: 3 }), record({ at: 2 })];
    expect(appendRun(history, record({ at: 4 }), 2).map((run) => run.at)).toEqual([4, 3]);
  });
});

describe('runTitle and describeRun', () => {
  it('names the run by what it was and how it went', () => {
    expect(runTitle(record({ operation: 'pull', outcome: 'ok' }))).toBe('Pull finished');
    expect(runTitle(record({ outcome: 'partial' }))).toBe('Push finished with problems');
    expect(runTitle(record({ outcome: 'cancelled' }))).toBe('Push stopped');
    expect(runTitle(record({ outcome: 'failed' }))).toBe('Push failed');
  });

  it('lists what moved, how much and how long', () => {
    expect(describeRun(record({ files: 3, bytes: 2_048, durationMs: 62_000 }))).toBe(
      '3 files · 2.0 KB · 1 min',
    );
  });

  it('leaves out a duration too short to be worth claiming', () => {
    expect(describeRun(record({ files: 1, bytes: 100, durationMs: 40 }))).toBe('1 file · 100 B');
  });

  it('shows the error instead of a row of zeroes for a run that never started', () => {
    expect(describeRun(record({ outcome: 'failed', message: 'No credentials.' }))).toBe(
      'No credentials.',
    );
  });
});

describe('formatAgo', () => {
  it('gets coarser as it gets older', () => {
    const now = 10 * HOUR;
    expect(formatAgo(now - 30_000, now)).toBe('just now');
    expect(formatAgo(now - 2 * MINUTE, now)).toBe('2 min');
    expect(formatAgo(now - 3 * HOUR, now)).toBe('3 h');
    expect(formatAgo(now - 50 * HOUR, now)).toBe('2 d');
  });

  it('never reads as the future when a clock is a little ahead', () => {
    expect(formatAgo(2_000, 1_000)).toBe('just now');
  });
});

describe('formatWhen', () => {
  const now = new Date(2026, 6, 30, 15, 0).getTime();

  it('gives the time of day for today', () => {
    expect(formatWhen(new Date(2026, 6, 30, 9, 5).getTime(), now)).toBe('09:05');
  });

  it('names yesterday', () => {
    expect(formatWhen(new Date(2026, 6, 29, 23, 50).getTime(), now)).toBe('yesterday');
  });

  it('falls back to a date further back', () => {
    expect(formatWhen(new Date(2026, 6, 12, 8, 0).getTime(), now)).toBe('12 Jul');
  });
});

describe('dailyBytes', () => {
  const now = new Date(2026, 6, 30, 15, 0).getTime();

  it('buckets by local day, oldest first and today last', () => {
    const history = [
      record({ at: new Date(2026, 6, 30, 9, 0).getTime(), bytes: 100 }),
      record({ at: new Date(2026, 6, 30, 14, 0).getTime(), bytes: 50 }),
      record({ at: new Date(2026, 6, 29, 22, 0).getTime(), bytes: 7 }),
    ];

    expect(dailyBytes(history, 3, now)).toEqual([0, 7, 150]);
  });

  it('ignores runs older than the window, and runs from the future', () => {
    const history = [
      record({ at: new Date(2026, 5, 1).getTime(), bytes: 999 }),
      record({ at: new Date(2026, 7, 5).getTime(), bytes: 999 }),
    ];

    expect(dailyBytes(history, 3, now)).toEqual([0, 0, 0]);
  });

  it('asks for no days and gets none', () => {
    expect(dailyBytes([record()], 0, now)).toEqual([]);
  });
});
