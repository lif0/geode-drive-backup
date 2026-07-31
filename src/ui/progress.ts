import { Notice } from 'obsidian';

import type { AppError, OperationSummary, ProgressReporter } from '../types';

/**
 * Progress and summaries, rendered as Notices.
 *
 * One Notice is created per operation and its text is rewritten as work
 * proceeds, rather than spawning one per file — a 500-note push would otherwise
 * bury the app in toasts.
 */

/** How long the closing summary stays on screen. */
const SUMMARY_DURATION_MS = 12_000;

/** Trimmed so a long path does not push the counter off a phone screen. */
function shorten(label: string, max = 44): string {
  if (label.length <= max) return label;
  return `…${label.slice(label.length - max + 1)}`;
}

/** Human-readable one-liner for a failure. */
export function describeError(error: AppError): string {
  switch (error.kind) {
    case 'cancelled':
      return `Geode: ${error.message}`;
    case 'conflict':
      return `Geode: ${error.message} Pull first if you want the other device's copy.`;
    case 'auth':
    case 'network':
    case 'crypto':
    case 'io':
      return `Geode: ${error.message}`;
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

  lines.push(`${verb} finished: ${parts.length > 0 ? parts.join(', ') : 'nothing to do'}.`);

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

/** A ProgressReporter backed by a single, rewritten Notice. */
export class NoticeProgress implements ProgressReporter {
  private notice: Notice | null = null;
  private label = '';
  private total = 0;
  private completed = 0;

  begin(label: string, total: number): void {
    this.label = label;
    this.total = total;
    this.completed = 0;

    const text = total > 0 ? `Geode: ${label} (0/${String(total)})` : `Geode: ${label}…`;
    if (this.notice === null) {
      // Duration 0 keeps it up until the operation replaces or hides it.
      this.notice = new Notice(text, 0);
    } else {
      this.notice.setMessage(text);
    }
  }

  advance(detail: string): void {
    this.completed += 1;
    this.notice?.setMessage(
      `Geode: ${this.label} (${String(this.completed)}/${String(this.total)})\n${shorten(detail)}`,
    );
  }

  done(summary: OperationSummary): void {
    this.hide();
    new Notice(renderSummary(summary), SUMMARY_DURATION_MS);
  }

  fail(error: AppError): void {
    this.hide();
    // A cancellation is the user's own doing; say so briefly and without alarm.
    const duration = error.kind === 'cancelled' ? 4000 : SUMMARY_DURATION_MS;
    new Notice(describeError(error), duration);
  }

  private hide(): void {
    this.notice?.hide();
    this.notice = null;
  }
}
