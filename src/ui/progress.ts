import { Notice } from 'obsidian';

import { formatBytes, formatDuration, formatRate } from '../core/bytes';
import type { AppError, OperationSummary, ProgressReporter, VaultPath } from '../types';

/**
 * Progress state, and the two things that read it.
 *
 * This used to be one `Notice` per run. A Notice in Obsidian closes when you
 * click it — which people do, by accident, reaching for something behind it —
 * and that took the counter, the file name and the Cancel button with it. The
 * run carried on invisibly and the only way to stop it was the command palette.
 *
 * So the state lives here instead, in one hub that outlives any run, and the
 * things that draw it — a status bar item and a sidebar panel — subscribe. Both
 * can be closed and reopened at will; neither can lose the run.
 */

/** How long the closing summary Notice stays on screen. */
const SUMMARY_DURATION_MS = 12_000;

/**
 * Minimum gap between repaints.
 *
 * A large vault fires thousands of updates. Touching the DOM on every one of
 * them costs more than the work being reported, so they are coalesced and the
 * frames that matter — a phase starting, a run ending — are always flushed.
 */
const REPAINT_INTERVAL_MS = 100;

/** The file currently in flight. */
export interface FileProgress {
  readonly path: string;
  readonly done: number;
  readonly total: number;
}

/** Everything a renderer needs. Replaced wholesale, never mutated in place. */
export interface ProgressSnapshot {
  readonly running: boolean;
  /** "Reading vault", "Pushing", "Pulling". */
  readonly label: string;
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly bytesDone: number;
  /** 0 for a phase that moves no bytes, which hides the byte counters. */
  readonly bytesTotal: number;
  /** When this phase began, for working out a rate. 0 when nothing is running. */
  readonly startedAt: number;
  /** Set only while a file is in flight, so the second bar knows what to fill. */
  readonly file: FileProgress | null;
  /** The last path touched. Phases with no per-file bar still have one of these. */
  readonly detail: string;
  readonly note: string;
  /** The last finished run. Shown when nothing is in flight. */
  readonly summary: OperationSummary | null;
  readonly error: AppError | null;
}

const IDLE: ProgressSnapshot = {
  running: false,
  label: '',
  filesDone: 0,
  filesTotal: 0,
  bytesDone: 0,
  bytesTotal: 0,
  startedAt: 0,
  file: null,
  detail: '',
  note: '',
  summary: null,
  error: null,
};

/** Human-readable one-liner for a failure. */
export function describeError(error: AppError): string {
  switch (error.kind) {
    case 'cancelled':
      return `GeodeDrive: ${error.message}`;
    case 'conflict':
      return `GeodeDrive: ${error.message} Pull first if you want the other device's copy.`;
    case 'auth':
    case 'network':
    case 'crypto':
    case 'io':
      return `GeodeDrive: ${error.message}`;
  }
}

/** Multi-line text for the closing Notice and for the panel's footer. */
export function renderSummary(summary: OperationSummary): string {
  const lines: string[] = [];
  const verb = summary.operation === 'push' ? 'Push' : 'Pull';

  const parts: string[] = [];
  if (summary.uploaded > 0) parts.push(`${String(summary.uploaded)} uploaded`);
  if (summary.updated > 0) parts.push(`${String(summary.updated)} updated`);
  if (summary.downloaded > 0) parts.push(`${String(summary.downloaded)} downloaded`);
  if (summary.moved > 0) parts.push(`${String(summary.moved)} moved on Drive`);
  if (summary.renamed > 0) parts.push(`${String(summary.renamed)} kept side by side`);
  if (summary.deleted > 0) parts.push(`${String(summary.deleted)} deleted from Drive`);
  if (summary.skipped > 0) parts.push(`${String(summary.skipped)} unchanged`);
  if (summary.excluded > 0) parts.push(`${String(summary.excluded)} excluded`);

  const done = parts.length > 0 ? parts.join(', ') : 'nothing to do';
  lines.push(summary.cancelled ? `${verb} stopped: ${done}.` : `${verb} finished: ${done}.`);

  if (summary.cancelled) {
    lines.push('Everything already transferred is recorded. Run it again to carry on.');
  }

  if (summary.conflicts.length > 0) {
    lines.push('');
    lines.push(`${String(summary.conflicts.length)} skipped — changed on another device:`);
    for (const path of summary.conflicts.slice(0, 5)) lines.push(`  ${path}`);
    if (summary.conflicts.length > 5) {
      lines.push(`  …and ${String(summary.conflicts.length - 5)} more`);
    }
  }

  if (summary.failures.length > 0) {
    lines.push('');
    lines.push(`${String(summary.failures.length)} failed:`);
    for (const failure of summary.failures.slice(0, 5)) {
      lines.push(`  ${failure.path}: ${failure.message}`);
    }
    if (summary.failures.length > 5) {
      lines.push(`  …and ${String(summary.failures.length - 5)} more`);
    }
  }

  // Last, because a warning is about the shape of the backup rather than about
  // this run, and the counts above are what the user came to read.
  for (const warning of summary.warnings) {
    lines.push('');
    lines.push(warning);
  }

  return lines.join('\n');
}

/** Percentage, clamped, safe when the total is unknown. */
export function percentOf(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/**
 * The status bar line.
 *
 * Kept short: the status bar is shared with every other plugin, and a line that
 * pushes its neighbours off the screen is its own kind of rude.
 */
export function statusBarText(snapshot: ProgressSnapshot): string {
  if (!snapshot.running) {
    if (snapshot.error !== null) return 'Geode: stopped';
    if (snapshot.summary !== null) {
      const failed = snapshot.summary.failures.length;
      return failed > 0 ? `Geode: ${String(failed)} failed` : 'Geode: done';
    }
    return 'Geode';
  }

  const counted = `${String(snapshot.filesDone)}/${String(snapshot.filesTotal)}`;
  if (snapshot.bytesTotal <= 0) return `Geode ${counted}`;
  return `Geode ${counted} · ${String(percentOf(snapshot.bytesDone, snapshot.bytesTotal))}%`;
}

/**
 * Holds the progress of the current run and tells its renderers about it.
 *
 * One instance per plugin load, not one per run: the panel and the status bar
 * subscribe once at startup and stay subscribed.
 */
export class ProgressHub implements ProgressReporter {
  private state: ProgressSnapshot = IDLE;
  private readonly listeners = new Set<(snapshot: ProgressSnapshot) => void>();
  private lastPaint = 0;
  /** Bytes of files already finished. The bar adds the file in flight to this. */
  private settledBytes = 0;

  /** `onCancel` is what the panel's Cancel button asks for. */
  constructor(private readonly onCancel: () => void) {}

  /** Registers a renderer. Call the returned function to stop listening. */
  subscribe(listener: (snapshot: ProgressSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  snapshot(): ProgressSnapshot {
    return this.state;
  }

  requestCancel(): void {
    this.onCancel();
  }

  /* ---------------------------- ProgressReporter --------------------------- */

  begin(label: string, totalFiles: number, totalBytes: number): void {
    this.settledBytes = 0;
    this.state = {
      ...IDLE,
      running: true,
      label,
      filesTotal: totalFiles,
      bytesTotal: totalBytes,
      startedAt: Date.now(),
      // A new phase within one run must not wipe what the run already reported.
      summary: null,
      error: null,
    };
    this.emit(true);
  }

  beginFile(path: VaultPath, totalBytes: number): void {
    // Throttled, not forced: on a vault of five thousand small notes this fires
    // five thousand times, and forcing a repaint on each one would cost more
    // than the uploads being reported.
    this.state = { ...this.state, detail: path, file: { path, done: 0, total: totalBytes } };
    this.emit(false);
  }

  fileProgress(bytesDone: number): void {
    const file = this.state.file;
    if (file === null) return;

    const done = Math.max(file.done, Math.min(bytesDone, file.total));
    this.state = {
      ...this.state,
      file: { ...file, done },
      bytesDone: this.settledBytes + done,
    };
    this.emit(false);
  }

  advance(label: string): void {
    // Whatever the file reported along the way, it is finished now, so it counts
    // in full. Anything else lets the overall bar drift below the truth on every
    // transfer small enough to have been sent in a single request.
    this.settledBytes += this.state.file?.total ?? 0;
    this.state = {
      ...this.state,
      filesDone: this.state.filesDone + 1,
      bytesDone: this.settledBytes,
      detail: label,
      file: null,
    };
    this.emit(false);
  }

  note(text: string): void {
    this.state = { ...this.state, note: text };
    this.emit(false);
  }

  /**
   * Back to nothing running, with no summary and no Notice.
   *
   * For work that reports progress but has no outcome to announce — a dry run,
   * which walks the vault exactly as a push does and then has nothing to say
   * about it beyond the numbers the panel already shows.
   */
  idle(): void {
    this.settledBytes = 0;
    this.state = IDLE;
    this.emit(true);
  }

  done(summary: OperationSummary): void {
    this.state = { ...IDLE, summary };
    this.emit(true);
    new Notice(renderSummary(summary), SUMMARY_DURATION_MS);
  }

  fail(error: AppError): void {
    this.state = { ...IDLE, error };
    this.emit(true);
    // A cancellation is the user's own doing: say so briefly and without alarm.
    new Notice(describeError(error), error.kind === 'cancelled' ? 4000 : SUMMARY_DURATION_MS);
  }

  /* -------------------------------------------------------------------------- */

  private emit(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastPaint < REPAINT_INTERVAL_MS) return;
    this.lastPaint = now;

    for (const listener of this.listeners) listener(this.state);
  }
}

/** Renders a byte pair as `4.1 MB of 5.0 MB`, or empty when there is no total. */
export function renderBytes(done: number, total: number): string {
  if (total <= 0) return '';
  return `${formatBytes(done)} of ${formatBytes(total)}`;
}

/** Nothing is claimed about the speed until a run has been going this long. */
const RATE_SETTLE_MS = 3000;

/**
 * Speed and time remaining, or empty until there is enough to say.
 *
 * The single most useful number on the panel when a push feels slow, because it
 * settles the only question that matters: a steady 15 MB/s is the connection
 * doing its best and nothing here will improve it, while 400 KB/s on a fast
 * line means the time is going somewhere other than the wire.
 */
export function renderRate(snapshot: ProgressSnapshot, now: number): string {
  const elapsed = now - snapshot.startedAt;
  if (snapshot.bytesTotal <= 0 || snapshot.bytesDone <= 0 || elapsed < RATE_SETTLE_MS) return '';

  const rate = (snapshot.bytesDone / elapsed) * 1000;
  const left = (snapshot.bytesTotal - snapshot.bytesDone) / rate;
  return `${formatRate(rate)} · about ${formatDuration(left)} left`;
}
