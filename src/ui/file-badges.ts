import type { Workspace } from 'obsidian';

import type { BackupState } from '../core/backup-state';
import { BACKUP_STATES } from '../core/backup-state';

/**
 * Dots in Obsidian's file explorer saying what is in the backup.
 *
 * Obsidian offers plugins no API for decorating the file tree, so this reads the
 * DOM: every row the explorer draws carries a `data-path`, and that attribute is
 * what CSS snippets have targeted for years. Nothing private is touched — no
 * internal view fields, no monkey-patching — but it is still a dependency on
 * markup rather than on a contract, and it is the first thing to check if the
 * dots ever stop appearing.
 *
 * The state is written as an attribute and drawn by CSS rather than injected as
 * an element. The explorer rebuilds rows freely — collapsing a folder, scrolling
 * a long list — and an attribute that goes missing is repaired by the next
 * refresh, where an orphaned element would have to be hunted down and removed.
 */

const STATE_ATTR = 'data-geode-state';
const ROW_SELECTOR = `.nav-file-title[data-path], .nav-folder-title[data-path]`;

/** Repaints are coalesced: the explorer emits mutations in bursts. */
const REFRESH_DELAY_MS = 150;

/** The stylesheet, injected from here so the plugin still ships two files. */
const STYLES = `
.nav-file-title[${STATE_ATTR}]::after,
.nav-folder-title[${STATE_ATTR}]::after {
  content: '';
  width: 6px;
  height: 6px;
  margin-left: auto;
  border-radius: 50%;
  flex: 0 0 auto;
  align-self: center;
}
.nav-file-title[${STATE_ATTR}='backed-up']::after,
.nav-folder-title[${STATE_ATTR}='backed-up']::after { background: var(--color-green); }
.nav-file-title[${STATE_ATTR}='pending']::after,
.nav-folder-title[${STATE_ATTR}='pending']::after { background: var(--color-orange); }
.nav-file-title[${STATE_ATTR}='excluded']::after,
.nav-folder-title[${STATE_ATTR}='excluded']::after { background: var(--text-faint); }
.nav-file-title[${STATE_ATTR}='excluded'],
.nav-folder-title[${STATE_ATTR}='excluded'] { opacity: 0.55; }
`;

/**
 * Keeps the explorer's dots in step with the index.
 *
 * `compute` is called on every refresh rather than cached, because what it
 * returns changes for reasons this class cannot see: a file edited, a push
 * finished, an exclusion rule added.
 */
export class FileExplorerBadges {
  private observer: MutationObserver | null = null;
  private style: HTMLStyleElement | null = null;
  private timer: number | null = null;

  constructor(
    private readonly workspace: Workspace,
    private readonly compute: () => Map<string, BackupState>,
  ) {}

  /** Starts drawing, and watches for rows the explorer rebuilds under us. */
  start(): void {
    if (this.style === null) {
      this.style = document.createElement('style');
      this.style.setText(STYLES);
      document.head.appendChild(this.style);
    }

    if (this.observer === null) {
      // Attribute changes are not observed, so writing our own state back does
      // not wake this up again.
      this.observer = new MutationObserver(() => {
        this.schedule();
      });
      this.observer.observe(this.workspace.containerEl, { childList: true, subtree: true });
    }

    this.refresh();
  }

  /** Repaints soon. Several calls in a row cost one repaint. */
  schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, REFRESH_DELAY_MS);
  }

  /** Writes the current state onto every row the explorer is showing. */
  refresh(): void {
    const states = this.compute();

    for (const row of Array.from(this.workspace.containerEl.querySelectorAll(ROW_SELECTOR))) {
      const path = row.getAttribute('data-path');
      const state = path === null ? undefined : states.get(path);

      if (state === undefined) row.removeAttribute(STATE_ATTR);
      else row.setAttribute(STATE_ATTR, state);
    }
  }

  /** Stops drawing and takes every mark back off. Called on unload and on off. */
  stop(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }

    this.observer?.disconnect();
    this.observer = null;

    for (const row of Array.from(this.workspace.containerEl.querySelectorAll(ROW_SELECTOR))) {
      row.removeAttribute(STATE_ATTR);
    }

    this.style?.remove();
    this.style = null;
  }
}

/** The states, in the order the legend lists them. */
export const BADGE_LEGEND: readonly { state: BackupState; label: string }[] = BACKUP_STATES.map(
  (state) => ({
    state,
    label:
      state === 'backed-up'
        ? 'green — on Drive and unchanged since'
        : state === 'pending'
          ? 'orange — not pushed yet, or changed since'
          : 'grey — excluded from the backup',
  }),
);
