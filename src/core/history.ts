/**
 * A log of finished runs.
 *
 * A backup that only ever says "done" tells you nothing the morning you need to
 * know whether last night's push actually happened. The Notice is gone by then,
 * the status bar has moved on, and the only durable evidence is the index — which
 * says what is on Drive and not when it got there.
 *
 * So every run leaves a line: when, what it moved, how long it took, and what
 * went wrong. Bounded, because this lives in data.json next to the index and a
 * log nobody reads is not worth a growing file.
 *
 * Records hold numbers, not sentences. Wording changes between versions; a
 * record written a year ago should still render the way today's panel renders
 * everything else.
 */

import { formatBytes, formatDuration } from './bytes';
import type { AppError, OperationSummary } from '../types';

/** How a run ended. */
export type RunOutcome =
  /** Everything it set out to do. */
  | 'ok'
  /** Finished, but some files failed or were skipped as conflicts. */
  | 'partial'
  /** Stopped by the user. What had already moved still counts. */
  | 'cancelled'
  /** Never got going: no credentials, no network, a bad passphrase. */
  | 'failed';

/** One finished run. */
export interface RunRecord {
  /** When it ended, as epoch milliseconds. */
  readonly at: number;
  readonly operation: 'push' | 'pull';
  readonly outcome: RunOutcome;
  /** Files that actually moved: uploaded, updated, downloaded, moved, deleted. */
  readonly files: number;
  /** Bytes across the wire, as the progress hub counted them. */
  readonly bytes: number;
  readonly durationMs: number;
  readonly conflicts: number;
  readonly failures: number;
  /** The error for a run that failed outright. Empty otherwise. */
  readonly message: string;
}

/** How many runs are kept. Older ones fall off the end. */
export const HISTORY_LIMIT = 40;

/** Turns a finished run into its record. */
export function recordOf(
  summary: OperationSummary,
  bytes: number,
  durationMs: number,
  at: number,
): RunRecord {
  const moved =
    summary.uploaded +
    summary.updated +
    summary.downloaded +
    summary.moved +
    summary.renamed +
    summary.deleted;

  return {
    at,
    operation: summary.operation,
    outcome: summary.cancelled
      ? 'cancelled'
      : summary.failures.length > 0 || summary.conflicts.length > 0
        ? 'partial'
        : 'ok',
    files: moved,
    bytes,
    durationMs,
    conflicts: summary.conflicts.length,
    failures: summary.failures.length,
    message: '',
  };
}

/**
 * Turns a run that never finished into its record.
 *
 * A cancellation is filed as cancelled rather than failed: the user asked for
 * it, and a log that shouts about it is a log people stop reading.
 */
export function failureOf(
  operation: 'push' | 'pull',
  error: AppError,
  bytes: number,
  durationMs: number,
  at: number,
): RunRecord {
  return {
    at,
    operation,
    outcome: error.kind === 'cancelled' ? 'cancelled' : 'failed',
    files: 0,
    bytes,
    durationMs,
    conflicts: 0,
    failures: 0,
    message: error.message,
  };
}

/** The log with `record` at the front, trimmed to `limit`. Never mutates. */
export function appendRun(
  history: readonly RunRecord[],
  record: RunRecord,
  limit = HISTORY_LIMIT,
): RunRecord[] {
  return [record, ...history].slice(0, Math.max(0, limit));
}

/** The headline for one record: what it was, and how it went. */
export function runTitle(record: RunRecord): string {
  const verb = record.operation === 'push' ? 'Push' : 'Pull';
  switch (record.outcome) {
    case 'ok':
      return `${verb} finished`;
    case 'partial':
      return `${verb} finished with problems`;
    case 'cancelled':
      return `${verb} stopped`;
    case 'failed':
      return `${verb} failed`;
  }
}

/** The line under the headline: what moved, how much, how long. */
export function describeRun(record: RunRecord): string {
  if (record.outcome === 'failed' && record.files === 0) return record.message;

  const parts: string[] = [`${String(record.files)} ${record.files === 1 ? 'file' : 'files'}`];
  if (record.bytes > 0) parts.push(formatBytes(record.bytes));
  if (record.durationMs >= 1000) parts.push(formatDuration(record.durationMs / 1000));
  if (record.conflicts > 0) parts.push(`${String(record.conflicts)} conflicts`);
  if (record.failures > 0) parts.push(`${String(record.failures)} failed`);

  return parts.join(' · ');
}

const DAY_MS = 24 * 60 * 60 * 1000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * How long ago, for a list of things that just happened: `2 min`, `3 h`, `4 d`.
 *
 * Coarse on purpose. "Edited 2 minutes ago" is the whole of what the reader
 * wants from a list of recent files, and a second hand on it would only ask to
 * be watched.
 */
export function formatAgo(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} h`;
  return `${String(Math.floor(hours / 24))} d`;
}

/**
 * When something happened, for a log: `12:41` today, `yesterday`, `30 Jul`.
 *
 * Written out here rather than left to `toLocaleString`, which would answer in
 * whichever locale the device is set to while every other word in this panel is
 * in English — and would make the same record render differently on two of the
 * user's own machines.
 */
export function formatWhen(at: number, now: number): string {
  const age = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  const date = new Date(at);

  if (age <= 0) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }
  if (age === 1) return 'yesterday';
  return `${String(date.getDate())} ${MONTHS[date.getMonth()] ?? ''}`.trim();
}

/** Local midnight before `at`, so a bucket is a day as the user lived it. */
function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Bytes moved per day, oldest first, with today last.
 *
 * Rounded rather than divided exactly, because the clocks change twice a year
 * and a day is then 23 or 25 hours long.
 */
export function dailyBytes(
  history: readonly RunRecord[],
  days: number,
  now: number,
): readonly number[] {
  const buckets = new Array<number>(Math.max(0, days)).fill(0);
  if (buckets.length === 0) return buckets;

  const today = startOfDay(now);
  for (const record of history) {
    const age = Math.round((today - startOfDay(record.at)) / DAY_MS);
    if (age < 0 || age >= buckets.length) continue;
    const slot = buckets.length - 1 - age;
    buckets[slot] = (buckets[slot] ?? 0) + record.bytes;
  }

  return buckets;
}
