import { ItemView } from 'obsidian';
import type { IconName, WorkspaceLeaf } from 'obsidian';

import { formatBytes } from '../core/bytes';
import type { BackupEstimate } from '../ops/estimate';
import type { Result } from '../types';
import type { ProgressHub, ProgressSnapshot } from './progress';
import { percentOf, renderBytes, renderSummary } from './progress';

/**
 * The progress panel.
 *
 * Lives in the sidebar rather than in a Notice because a Notice is dismissed by
 * clicking it, and the click that dismisses it is usually aimed at something
 * else. A run can outlive several minutes and a locked phone; the thing
 * reporting on it should not be destroyed by a stray tap.
 *
 * Draws two bars. The overall one is honest for the whole run — every file's
 * size is known before the first byte moves, because the plan says so. The
 * per-file one only moves for transfers large enough to be sent in pieces;
 * anything smaller arrives in one request, and `requestUrl` has nothing to
 * report until it returns.
 */

export const GEODE_VIEW_TYPE = 'geode-progress';

/** What the panel needs from the plugin to do anything. */
export interface ProgressHost {
  isConnected(): boolean;
  isBusy(): boolean;
  /** The Drive folder the backup lives in. */
  backupFolderName(): string;
  trackedFileCount(): number;
  pushNow(): Promise<void>;
  pullNow(): Promise<void>;
  /** A dry run: what a push would send, and how full Drive is. */
  estimateBackup(): Promise<Result<BackupEstimate>>;
}

/** Trimmed so a long path does not stretch the sidebar. */
function shorten(label: string, max = 52): string {
  if (label.length <= max) return label;
  return `…${label.slice(label.length - max + 1)}`;
}

/** The dry run as lines of text, most useful first. */
function describeEstimate(estimate: BackupEstimate): string {
  const { push, remote, quota } = estimate;
  const lines: string[] = [];

  const outgoing = push.uploads + push.updates;
  lines.push(
    outgoing === 0
      ? 'Nothing to upload — the backup is up to date.'
      : `${String(outgoing)} files to upload · ${formatBytes(push.bytes)}` +
          ` (${String(push.uploads)} new, ${String(push.updates)} changed)`,
  );

  if (push.conflicts > 0) {
    lines.push(`${String(push.conflicts)} changed on another device and would be skipped.`);
  }
  if (push.deletions > 0) {
    lines.push(`${String(push.deletions)} would be deleted from Drive — mirroring is on.`);
  }

  lines.push('');
  lines.push(`Unchanged: ${String(push.unchanged)}`);
  if (push.excluded > 0) lines.push(`Excluded: ${String(push.excluded)}`);
  lines.push(`On Drive: ${String(remote.files)} files · ${formatBytes(remote.bytes)}`);

  if (quota === null) {
    lines.push('Drive space: not reported');
    return lines.join('\n');
  }

  if (quota.limit === null) {
    lines.push(`Drive space: ${formatBytes(quota.usage)} used, no limit`);
    return lines.join('\n');
  }

  const free = Math.max(0, quota.limit - quota.usage);
  lines.push(
    `Drive space: ${formatBytes(quota.usage)} of ${formatBytes(quota.limit)} used` +
      ` · ${formatBytes(free)} free`,
  );

  // The one number here that predicts a failure no retry can fix.
  if (push.bytes > free) {
    lines.push('');
    lines.push(`Not enough room: this push needs ${formatBytes(push.bytes - free)} more.`);
  }

  return lines.join('\n');
}

/** The elements the view rewrites. Built once, then only their text changes. */
interface Parts {
  readonly connection: HTMLElement;
  readonly actions: HTMLElement;
  readonly push: HTMLButtonElement;
  readonly pull: HTMLButtonElement;
  readonly check: HTMLButtonElement;
  readonly estimate: HTMLElement;
  /** Wraps everything that only means something while a run is in flight. */
  readonly progress: HTMLElement;
  readonly phase: HTMLElement;
  readonly overallCount: HTMLElement;
  readonly overallFill: HTMLElement;
  readonly overallBytes: HTMLElement;
  readonly fileName: HTMLElement;
  readonly fileTrack: HTMLElement;
  readonly fileFill: HTMLElement;
  readonly fileBytes: HTMLElement;
  readonly note: HTMLElement;
  readonly cancel: HTMLButtonElement;
  readonly footer: HTMLElement;
}

/** A track with a fill inside it. Returns the fill, which is what moves. */
function createBar(parent: HTMLElement): { track: HTMLElement; fill: HTMLElement } {
  const track = parent.createDiv();
  track.style.height = '6px';
  track.style.margin = '6px 0';
  track.style.borderRadius = '3px';
  track.style.overflow = 'hidden';
  track.style.background = 'var(--background-modifier-border)';

  const fill = track.createDiv();
  fill.style.height = '100%';
  fill.style.width = '0%';
  fill.style.borderRadius = '3px';
  fill.style.background = 'var(--interactive-accent)';
  fill.style.transition = 'width 120ms linear';

  return { track, fill };
}

function createCaption(parent: HTMLElement): HTMLElement {
  const element = parent.createDiv();
  element.style.fontSize = 'var(--font-ui-smaller)';
  element.style.opacity = '0.7';
  return element;
}

export class GeodeProgressView extends ItemView {
  private parts: Parts | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly hub: ProgressHub,
    private readonly host: ProgressHost,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return GEODE_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return 'GeodeDrive';
  }

  override getIcon(): IconName {
    return 'upload-cloud';
  }

  protected override async onOpen(): Promise<void> {
    this.parts = this.build();
    // subscribe() paints once with the current state, so a panel opened halfway
    // through a run shows the run rather than an empty shell.
    this.unsubscribe = this.hub.subscribe((snapshot) => {
      this.render(snapshot);
    });
    return Promise.resolve();
  }

  protected override async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.parts = null;
    this.contentEl.empty();
    return Promise.resolve();
  }

  private build(): Parts {
    const root = this.contentEl;
    root.empty();
    root.style.padding = '0 12px';

    const connection = createCaption(root);
    connection.style.marginTop = '8px';

    // Push and pull live here as well as in the palette and the settings tab,
    // because this is the screen you are already looking at when you decide to
    // run one — and the only one that can tell you what it is about to do.
    const actions = root.createDiv();
    actions.style.display = 'flex';
    actions.style.gap = '6px';
    actions.style.margin = '10px 0';

    const push = actions.createEl('button', { text: 'Push' });
    push.addClass('mod-cta');
    push.style.flex = '1';
    push.addEventListener('click', () => {
      this.start(() => this.host.pushNow());
    });

    const pull = actions.createEl('button', { text: 'Pull' });
    pull.style.flex = '1';
    pull.addEventListener('click', () => {
      this.start(() => this.host.pullNow());
    });

    const check = root.createEl('button', { text: 'Check what would be pushed' });
    check.style.width = '100%';
    check.addEventListener('click', () => {
      void this.runEstimate();
    });

    const estimate = root.createDiv();
    estimate.style.marginTop = '10px';
    estimate.style.fontSize = 'var(--font-ui-smaller)';
    estimate.style.whiteSpace = 'pre-wrap';
    estimate.style.opacity = '0.85';

    // Hidden between runs. An empty "Overall" heading over an empty bar reads
    // as a thing that is broken rather than a thing that is not running.
    const progress = root.createDiv();

    const phase = progress.createEl('h4');
    phase.style.marginBottom = '2px';

    const overallHeader = progress.createDiv();
    overallHeader.style.display = 'flex';
    overallHeader.style.justifyContent = 'space-between';
    overallHeader.style.alignItems = 'baseline';
    const overallTitle = overallHeader.createDiv();
    overallTitle.setText('Overall');
    overallTitle.style.fontSize = 'var(--font-ui-smaller)';
    const overallCount = createCaption(overallHeader);

    const overall = createBar(progress);
    const overallBytes = createCaption(progress);

    const fileName = progress.createDiv();
    fileName.style.marginTop = '14px';
    fileName.style.fontSize = 'var(--font-ui-smaller)';
    fileName.style.wordBreak = 'break-all';

    const file = createBar(progress);
    const fileBytes = createCaption(progress);

    const note = createCaption(progress);
    note.style.marginTop = '10px';

    const cancel = progress.createEl('button', { text: 'Cancel' });
    cancel.style.marginTop = '14px';
    cancel.style.width = '100%';
    cancel.addEventListener('click', () => {
      cancel.disabled = true;
      cancel.setText('Stopping…');
      this.hub.requestCancel();
    });

    const footer = root.createDiv();
    footer.style.marginTop = '14px';
    footer.style.fontSize = 'var(--font-ui-smaller)';
    footer.style.opacity = '0.75';
    footer.style.whiteSpace = 'pre-wrap';

    return {
      connection,
      actions,
      push,
      pull,
      check,
      estimate,
      progress,
      phase,
      overallCount,
      overallFill: overall.fill,
      overallBytes,
      fileName,
      fileTrack: file.track,
      fileFill: file.fill,
      fileBytes,
      note,
      cancel,
      footer,
    };
  }

  /**
   * Starts a run and greys the buttons at once.
   *
   * A push spends its first seconds resolving the Drive folder and listing it,
   * and only then reports a phase. Waiting for that first report to disable the
   * buttons leaves a window in which Push looks like it did nothing and invites
   * a second click.
   */
  private start(run: () => Promise<void>): void {
    const parts = this.parts;
    if (parts !== null) {
      parts.push.disabled = true;
      parts.pull.disabled = true;
      parts.check.disabled = true;
    }
    void run();
  }

  /** Runs the dry run and leaves its answer on screen until the next one. */
  private async runEstimate(): Promise<void> {
    const parts = this.parts;
    if (parts === null) return;

    parts.push.disabled = true;
    parts.pull.disabled = true;
    parts.check.disabled = true;
    parts.estimate.setText('Checking…');

    const result = await this.host.estimateBackup();

    // The panel may have been closed and rebuilt while the vault was hashed.
    const current = this.parts;
    if (current === null) return;

    current.estimate.setText(
      result.ok ? describeEstimate(result.value) : `Could not check: ${result.error.message}`,
    );
    this.renderHeader(current);
  }

  private render(snapshot: ProgressSnapshot): void {
    const parts = this.parts;
    if (parts === null) return;

    this.renderHeader(parts);

    if (!snapshot.running) {
      this.renderIdle(parts, snapshot);
      return;
    }

    parts.progress.style.display = '';
    parts.phase.setText(snapshot.label);
    parts.overallCount.setText(
      `${String(snapshot.filesDone)} / ${String(snapshot.filesTotal)} files`,
    );

    // Fall back to counting files when the phase moves no bytes, so the bar
    // still means something while the vault is being hashed.
    const overallPercent =
      snapshot.bytesTotal > 0
        ? percentOf(snapshot.bytesDone, snapshot.bytesTotal)
        : percentOf(snapshot.filesDone, snapshot.filesTotal);
    parts.overallFill.style.width = `${String(overallPercent)}%`;
    parts.overallBytes.setText(
      snapshot.bytesTotal > 0
        ? `${renderBytes(snapshot.bytesDone, snapshot.bytesTotal)} · ${String(overallPercent)}%`
        : '',
    );

    parts.fileName.setText(shorten(snapshot.detail));

    const file = snapshot.file;
    if (file === null || file.total <= 0) {
      // Nothing in flight, or a file small enough to have gone in one request.
      // An empty bar is more honest than a full one that never filled.
      parts.fileTrack.style.visibility = 'hidden';
      parts.fileBytes.setText('');
    } else {
      const filePercent = percentOf(file.done, file.total);
      parts.fileTrack.style.visibility = 'visible';
      parts.fileFill.style.width = `${String(filePercent)}%`;
      parts.fileBytes.setText(`${renderBytes(file.done, file.total)} · ${String(filePercent)}%`);
    }

    parts.note.setText(snapshot.note);
    parts.cancel.disabled = false;
    parts.cancel.setText('Cancel');
    parts.footer.setText('');
    // A dry run taken before the push started describes a vault that is now
    // changing under it. Better blank than stale.
    parts.estimate.setText('');
  }

  /** The lines that mean the same thing whether or not a run is in flight. */
  private renderHeader(parts: Parts): void {
    const connected = this.host.isConnected();
    const busy = this.host.isBusy();

    parts.connection.setText(
      connected
        ? `Backing up to “${this.host.backupFolderName()}” · ${String(this.host.trackedFileCount())} files tracked`
        : 'Not connected to Google Drive. Add your OAuth client in settings.',
    );

    // Disabled rather than hidden: a greyed-out Push explains why nothing
    // happens when you reach for it, where a missing one just looks broken.
    const ready = connected && !busy;
    parts.push.disabled = !ready;
    parts.pull.disabled = !ready;
    parts.check.disabled = !ready;
  }

  private renderIdle(parts: Parts, snapshot: ProgressSnapshot): void {
    parts.progress.style.display = 'none';
    parts.overallFill.style.width = '0%';
    parts.fileFill.style.width = '0%';

    if (snapshot.summary !== null) {
      parts.footer.setText(renderSummary(snapshot.summary));
      return;
    }
    if (snapshot.error !== null) {
      parts.footer.setText(snapshot.error.message);
      return;
    }
    parts.footer.setText('');
  }
}
