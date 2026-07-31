import { Notice } from 'obsidian';

import type { AppError, OperationSummary, ProgressReporter } from '../types';

/**
 * Progress and summaries, rendered as Notices.
 *
 * One Notice per operation, rewritten in place. Spawning one per file would bury
 * the app on any vault worth backing up.
 */

/** How long the closing summary stays on screen. */
const SUMMARY_DURATION_MS = 12_000;

/**
 * Minimum gap between repaints.
 *
 * A large vault fires thousands of `advance` calls. Touching the DOM on every
 * one of them costs more than the work being reported, so updates are coalesced
 * and the final count is always flushed.
 */
const REPAINT_INTERVAL_MS = 100;

/** Trimmed so a long path does not push the counter off a phone screen. */
function shorten(label: string, max = 44): string {
  if (label.length <= max) return label;
  return `…${label.slice(label.length - max + 1)}`;
}

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

/** Multi-line text for the closing Notice. */
export function renderSummary(summary: OperationSummary): string {
  const lines: string[] = [];
  const verb = summary.operation === 'push' ? 'Push' : 'Pull';

  const parts: string[] = [];
  if (summary.uploaded > 0) parts.push(`${String(summary.uploaded)} uploaded`);
  if (summary.updated > 0) parts.push(`${String(summary.updated)} updated`);
  if (summary.downloaded > 0) parts.push(`${String(summary.downloaded)} downloaded`);
  if (summary.renamed > 0) parts.push(`${String(summary.renamed)} kept side by side`);
  if (summary.deleted > 0) parts.push(`${String(summary.deleted)} deleted from Drive`);
  if (summary.skipped > 0) parts.push(`${String(summary.skipped)} unchanged`);

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

  return lines.join('\n');
}

/**
 * A ProgressReporter backed by one rewritten Notice, with a Cancel button.
 *
 * The button writes into `messageEl`, which exists from Obsidian 1.8.7; the
 * manifest requires 1.12, so it is always there.
 */
export class NoticeProgress implements ProgressReporter {
  private notice: Notice | null = null;
  private textEl: HTMLElement | null = null;
  private noteEl: HTMLElement | null = null;

  private label = '';
  private detail = '';
  private total = 0;
  private completed = 0;
  private lastPaint = 0;

  /** `onCancel` is called from the button. Omit it for a run that cannot stop. */
  constructor(private readonly onCancel: (() => void) | null = null) {}

  begin(label: string, total: number): void {
    this.label = label;
    this.total = total;
    this.completed = 0;
    this.detail = '';
    this.lastPaint = 0;

    if (this.notice === null) this.createNotice();
    this.paint(true);
  }

  advance(detail: string): void {
    this.completed += 1;
    this.detail = detail;
    this.paint(false);
  }

  /** A one-off line under the counter, e.g. how much work the cache saved. */
  note(text: string): void {
    this.noteEl?.setText(text);
  }

  done(summary: OperationSummary): void {
    this.hide();
    new Notice(renderSummary(summary), SUMMARY_DURATION_MS);
  }

  fail(error: AppError): void {
    this.hide();
    // A cancellation is the user's own doing: say so briefly and without alarm.
    const duration = error.kind === 'cancelled' ? 4000 : SUMMARY_DURATION_MS;
    new Notice(describeError(error), duration);
  }

  private createNotice(): void {
    // Duration 0 keeps it up until the operation replaces or hides it.
    const notice = new Notice('', 0);
    notice.messageEl.empty();

    this.textEl = notice.messageEl.createDiv();
    this.noteEl = notice.messageEl.createDiv();
    this.noteEl.style.opacity = '0.7';
    this.noteEl.style.fontSize = 'var(--font-ui-smaller)';

    if (this.onCancel !== null) {
      const cancel = notice.messageEl.createEl('button', { text: 'Cancel' });
      cancel.style.marginTop = '0.6em';
      cancel.addEventListener('click', () => {
        cancel.disabled = true;
        cancel.setText('Stopping…');
        this.onCancel?.();
      });
    }

    this.notice = notice;
  }

  /**
   * Repaints at most every REPAINT_INTERVAL_MS. `force` is for the first and
   * last frame, where being current matters more than being cheap.
   */
  private paint(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastPaint < REPAINT_INTERVAL_MS) return;
    this.lastPaint = now;

    const counter =
      this.total > 0
        ? `${this.label} ${String(this.completed)}/${String(this.total)}`
        : `${this.label}…`;
    const detail = this.detail.length > 0 ? `\n${shorten(this.detail)}` : '';
    this.textEl?.setText(`GeodeDrive: ${counter}${detail}`);
  }

  private hide(): void {
    this.notice?.hide();
    this.notice = null;
    this.textEl = null;
    this.noteEl = null;
  }
}
