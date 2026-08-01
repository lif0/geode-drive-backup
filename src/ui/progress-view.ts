import { ItemView } from 'obsidian';
import type { IconName, WorkspaceLeaf } from 'obsidian';

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

/** Trimmed so a long path does not stretch the sidebar. */
function shorten(label: string, max = 52): string {
  if (label.length <= max) return label;
  return `…${label.slice(label.length - max + 1)}`;
}

/** The elements the view rewrites. Built once, then only their text changes. */
interface Parts {
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

    const phase = root.createEl('h4');
    phase.style.marginBottom = '2px';

    const overallHeader = root.createDiv();
    overallHeader.style.display = 'flex';
    overallHeader.style.justifyContent = 'space-between';
    overallHeader.style.alignItems = 'baseline';
    const overallTitle = overallHeader.createDiv();
    overallTitle.setText('Overall');
    overallTitle.style.fontSize = 'var(--font-ui-smaller)';
    const overallCount = createCaption(overallHeader);

    const overall = createBar(root);
    const overallBytes = createCaption(root);

    const fileName = root.createDiv();
    fileName.style.marginTop = '14px';
    fileName.style.fontSize = 'var(--font-ui-smaller)';
    fileName.style.wordBreak = 'break-all';

    const file = createBar(root);
    const fileBytes = createCaption(root);

    const note = createCaption(root);
    note.style.marginTop = '10px';

    const cancel = root.createEl('button', { text: 'Cancel' });
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

  private render(snapshot: ProgressSnapshot): void {
    const parts = this.parts;
    if (parts === null) return;

    if (!snapshot.running) {
      this.renderIdle(parts, snapshot);
      return;
    }

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
    parts.cancel.style.display = '';
    parts.footer.setText('');
  }

  private renderIdle(parts: Parts, snapshot: ProgressSnapshot): void {
    parts.phase.setText('GeodeDrive');
    parts.overallCount.setText('');
    parts.overallFill.style.width = '0%';
    parts.overallBytes.setText('');
    parts.fileName.setText('');
    parts.fileTrack.style.visibility = 'hidden';
    parts.fileBytes.setText('');
    parts.note.setText('');
    parts.cancel.style.display = 'none';

    if (snapshot.summary !== null) {
      parts.footer.setText(renderSummary(snapshot.summary));
      return;
    }
    if (snapshot.error !== null) {
      parts.footer.setText(snapshot.error.message);
      return;
    }
    parts.footer.setText(
      'Nothing running. Push or pull from the ribbon, the command palette, or settings.',
    );
  }
}
