import { ItemView } from 'obsidian';
import type { IconName, WorkspaceLeaf } from 'obsidian';

import type { RuleLine } from '../core/rule-stats';
import type { VaultSummary } from '../core/vault-stats';
import type { EstimateState, PanelContext, ProgressHost, TabId } from './panel-host';
import { TABS } from './panel-host';
import { ICONS, PANEL_STYLES, TONE_COLOR, createIcon } from './panel-dom';
import { buildIssues, footText, paneHead, renderTab, statusLine } from './panel-tabs';
import type { ProgressHub, ProgressSnapshot } from './progress';

/**
 * The panel.
 *
 * Lives in the sidebar rather than in a Notice because a Notice is dismissed by
 * clicking it, and the click that dismisses it is usually aimed at something
 * else. A run can outlive several minutes and a locked phone; the thing
 * reporting on it should not be destroyed by a stray tap.
 *
 * It grew from that one job into seven tabs for a simple reason: a backup tool
 * is asked the same four questions — what changed, what happened last night,
 * what is being left out, and what is wrong — and every one of them had been
 * answered by a Notice that was already gone, or by a settings page nobody
 * opens. The bars are still the point; the rest is what people needed to see
 * around them.
 *
 * Everything on screen is a picture of one moment. A repaint rebuilds the tab
 * from the state as it stands, which is why nothing here caches a rendered
 * value: a panel with a running push on it cannot be allowed to disagree with
 * the push.
 */

export const GEODE_VIEW_TYPE = 'geode-progress';

export type { ProgressHost } from './panel-host';

/** How long a vault summary is reused before it is worked out again. */
const SUMMARY_TTL_MS = 1000;

/**
 * The stylesheet, shared by every open panel.
 *
 * Injected from here rather than shipped as styles.css so the plugin stays two
 * files, which is also how `file-badges.ts` does it. Reference-counted because
 * the panel can be opened in two leaves at once and closing one of them must not
 * take the other's styling with it.
 */
let styleElement: HTMLStyleElement | null = null;
let styleUsers = 0;

function mountStyles(): void {
  styleUsers += 1;
  if (styleElement !== null) return;

  styleElement = document.createElement('style');
  styleElement.setText(PANEL_STYLES);
  document.head.appendChild(styleElement);
}

function unmountStyles(): void {
  styleUsers = Math.max(0, styleUsers - 1);
  if (styleUsers > 0) return;

  styleElement?.remove();
  styleElement = null;
}

/** The elements the view keeps hold of. Everything else is redrawn wholesale. */
interface Parts {
  readonly vaultName: HTMLElement;
  readonly vaultMeta: HTMLElement;
  readonly statusDot: HTMLElement;
  readonly statusText: HTMLElement;
  readonly tabs: ReadonlyMap<TabId, HTMLButtonElement>;
  readonly paneTitle: HTMLElement;
  readonly paneMeta: HTMLElement;
  readonly body: HTMLElement;
  readonly content: HTMLElement;
  readonly footLeft: HTMLElement;
  readonly footRight: HTMLElement;
}

export class GeodeProgressView extends ItemView {
  private parts: Parts | null = null;
  private unsubscribe: (() => void) | null = null;

  private tab: TabId = 'status';
  private snapshot: ProgressSnapshot;
  private estimate: EstimateState = { kind: 'none' };
  /** Null until the Excluded tab asks for them, and after every edit. */
  private rules: readonly RuleLine[] | null = null;
  private summaryCache: { at: number; value: VaultSummary } | null = null;
  /** Set by the Cancel button, cleared when the run it was aimed at stops. */
  private cancelling = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly hub: ProgressHub,
    private readonly host: ProgressHost,
  ) {
    super(leaf);
    this.snapshot = hub.snapshot();
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
    mountStyles();
    this.parts = this.build();

    // subscribe() paints once with the current state, so a panel opened halfway
    // through a run shows the run rather than an empty shell.
    this.unsubscribe = this.hub.subscribe((snapshot) => {
      const wasRunning = this.snapshot.running;
      this.snapshot = snapshot;

      // A run beginning or ending changes what every tab is allowed to offer, and
      // it leaves the vault looking different. Anything in between only moves
      // numbers the Status tab is drawing.
      const settled = wasRunning !== snapshot.running;
      if (settled) {
        this.summaryCache = null;
        this.cancelling = false;
      }
      this.repaint(settled || this.tab === 'status');
    });
    return Promise.resolve();
  }

  protected override async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.parts = null;
    this.contentEl.removeClass('geode-panel');
    this.contentEl.empty();
    unmountStyles();
    return Promise.resolve();
  }

  /* ------------------------------- building ------------------------------- */

  private build(): Parts {
    const root = this.contentEl;
    root.empty();
    root.addClass('geode-panel');

    const head = root.createDiv({ cls: 'geode-head' });
    const vault = head.createDiv({ cls: 'geode-vault' });
    createIcon(vault, ICONS.vault, 14);
    const vaultName = vault.createDiv({ cls: 'geode-vault-name' });
    const vaultMeta = vault.createDiv({ cls: 'geode-vault-meta' });

    const status = head.createDiv({ cls: 'geode-status' });
    const statusDot = status.createDiv({ cls: 'geode-status-dot' });
    const statusText = status.createDiv({ cls: 'geode-status-text' });

    const strip = root.createDiv({ cls: 'geode-tabs' });
    const tabs = new Map<TabId, HTMLButtonElement>();
    for (const tab of TABS) {
      const button = strip.createEl('button', { cls: 'geode-tab' });
      button.setAttribute('aria-label', tab.label);
      createIcon(button, tab.icon);
      button.addEventListener('click', () => {
        this.go(tab.id);
      });
      tabs.set(tab.id, button);
    }

    const content = root.createDiv({ cls: 'geode-body' });
    const paneHeadEl = content.createDiv({ cls: 'geode-pane-head' });
    const paneTitle = paneHeadEl.createEl('h2', { cls: 'geode-pane-title' });
    const paneMeta = paneHeadEl.createDiv({ cls: 'geode-pane-meta' });
    const body = content.createDiv({ cls: 'geode-stack' });

    const foot = root.createDiv({ cls: 'geode-foot' });
    const footLeft = foot.createSpan();
    const footRight = foot.createSpan();

    return {
      vaultName,
      vaultMeta,
      statusDot,
      statusText,
      tabs,
      paneTitle,
      paneMeta,
      body,
      content,
      footLeft,
      footRight,
    };
  }

  /* ------------------------------- painting ------------------------------- */

  /**
   * Redraws the header, the tab strip and the footer, and the body if asked.
   *
   * The body is left alone unless something it is showing actually changed,
   * because rebuilding it throws away the scroll position, any half-typed rule
   * and any list the reader had expanded — ten times a second, if a push is
   * running and they are reading a different tab.
   */
  private repaint(body: boolean): void {
    const parts = this.parts;
    if (parts === null) return;

    const ctx = this.context();

    parts.vaultName.setText(this.host.vaultName());
    parts.vaultMeta.setText(`${String(this.host.trackedFileCount())} tracked`);

    const status = statusLine(ctx);
    parts.statusText.setText(status.text);
    parts.statusDot.style.background = TONE_COLOR[status.tone];
    parts.statusDot.style.boxShadow = `0 0 0 3px color-mix(in srgb, ${TONE_COLOR[status.tone]} 20%, transparent)`;

    const issues = buildIssues(ctx).length;
    for (const [id, button] of parts.tabs) {
      button.toggleClass('is-active', id === this.tab);
      // The one tab that says something the others cannot: a dot on Issues, so a
      // failure is visible without opening it.
      button.querySelector('.geode-tab-mark')?.remove();
      if (id === 'issues' && issues > 0) {
        button.createDiv({ cls: 'geode-tab-mark' });
      }
    }

    const pane = paneHead(ctx, this.tab);
    parts.paneTitle.setText(pane.title);
    parts.paneMeta.setText(pane.meta);

    const foot = footText(ctx);
    parts.footLeft.setText(foot.left);
    parts.footRight.setText(foot.right);

    if (!body) return;
    const scroll = parts.content.scrollTop;
    parts.body.empty();
    renderTab(parts.body, ctx, this.tab);
    parts.content.scrollTop = scroll;
  }

  /** The state and the actions every tab is drawn from. */
  private context(): PanelContext {
    return {
      host: this.host,
      progress: this.snapshot,
      vault: this.vaultSummary(),
      now: Date.now(),
      estimate: this.estimate,
      rules: this.rules,
      cancelling: this.cancelling,

      go: (tab) => {
        this.go(tab);
      },
      refresh: () => {
        this.summaryCache = null;
        this.repaint(true);
      },
      start: (kind) => {
        this.start(kind);
      },
      cancel: () => {
        this.cancelling = true;
        this.hub.requestCancel();
        this.repaint(true);
      },
      check: () => {
        this.check();
      },
      update: (change) => {
        change(this.host.settings);
        // Painted before the write lands: a switch that waits for a disk write
        // to move reads as a switch that did not work.
        this.repaint(true);
        void this.host.saveSettings().then(() => {
          this.summaryCache = null;
          this.rules = null;
          this.repaint(true);
          this.loadRules();
        });
      },
      toggleRule: (rule, enabled) => {
        if (rule.source !== 'settings') return;
        void this.host.setExclusionRuleEnabled(rule.position, enabled).then(() => {
          this.afterRuleChange();
        });
      },
      addRule: (pattern) => {
        void this.host.addExclusionRule(pattern).then(() => {
          this.afterRuleChange();
        });
      },
    };
  }

  /**
   * The vault as it stands, worked out at most once a second.
   *
   * Cheap is not free: it walks every file the vault has. A push emits ten
   * frames a second, and doing this on each of them would put a full walk of the
   * vault between every two uploads.
   */
  private vaultSummary(): VaultSummary {
    const now = Date.now();
    const cached = this.summaryCache;
    if (cached !== null && now - cached.at < SUMMARY_TTL_MS) return cached.value;

    const value = this.host.vaultSummary();
    this.summaryCache = { at: now, value };
    return value;
  }

  /* -------------------------------- actions ------------------------------- */

  private go(tab: TabId): void {
    this.tab = tab;
    if (tab === 'excluded' && this.rules === null) this.loadRules();
    this.repaint(true);
    this.parts?.content.scrollTo({ top: 0 });
  }

  /**
   * Starts a run.
   *
   * A push spends its first seconds resolving the Drive folder and listing it,
   * and only then reports a phase. Repainting straight away — by which point the
   * plugin has already taken its busy flag — greys the buttons at once, where
   * waiting for the first progress frame would leave a window in which Push
   * looks like it did nothing and invites a second click.
   */
  private start(kind: 'push' | 'pull'): void {
    this.summaryCache = null;
    this.cancelling = false;
    // A plan worked out before this run describes a vault that is about to
    // change under it. Better cleared than stale.
    this.estimate = { kind: 'none' };

    const run = kind === 'push' ? this.host.pushNow() : this.host.pullNow();
    void run.then(() => {
      this.summaryCache = null;
      this.repaint(true);
    });
    this.repaint(true);
  }

  /** Runs the dry run, and leaves its answer on the Changes tab until the next one. */
  private check(): void {
    if (this.estimate.kind === 'loading') return;

    this.estimate = { kind: 'loading' };
    this.repaint(true);

    void this.host.estimateBackup().then(
      (result) => {
        this.estimate = result.ok
          ? { kind: 'ready', value: result.value, at: Date.now() }
          : { kind: 'error', message: result.error.message };
        this.summaryCache = null;
        this.repaint(true);
      },
      (cause: unknown) => {
        this.estimate = { kind: 'error', message: String(cause) };
        this.repaint(true);
      },
    );
  }

  /** Re-reads the rules after one was added or switched off. */
  private afterRuleChange(): void {
    this.summaryCache = null;
    this.rules = null;
    this.repaint(true);
    this.loadRules();
  }

  private loadRules(): void {
    void this.host.exclusionRules().then(
      (rules) => {
        // The panel may have been closed while the vault was being matched.
        if (this.parts === null) return;
        this.rules = rules;
        this.repaint(this.tab === 'excluded');
      },
      () => {
        if (this.parts === null) return;
        this.rules = [];
        this.repaint(this.tab === 'excluded');
      },
    );
  }
}
