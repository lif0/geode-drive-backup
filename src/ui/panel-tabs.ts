/**
 * The seven tabs.
 *
 * Each one is a function that fills a container from the context it is handed
 * and nothing else — no state of its own, no reaching back into the view. A tab
 * is therefore always a picture of the state as it was at the moment of the
 * repaint, which is the only way a screen with a running push on it can be kept
 * honest.
 *
 * The division of labour worth knowing: every number here except the ones on the
 * Changes tab comes from stats the app already holds, so the panel can draw
 * itself instantly and repaint whenever anything moves. What Drive actually
 * holds is the one thing that costs a walk of the vault and a network round
 * trip, so it lives behind a button and says when it was last asked.
 */

import type { BackupState } from '../core/backup-state';
import { formatBytes } from '../core/bytes';
import type { RunRecord } from '../core/history';
import { dailyBytes, describeRun, formatAgo, formatWhen, runTitle } from '../core/history';
import type { RuleLine } from '../core/rule-stats';
import type { BackupEstimate, ChangeKind, ChangedFile } from '../ops/estimate';
import type { PanelContext, TabId } from './panel-host';
import type { Tone } from './panel-dom';
import {
  ICONS,
  TONE_COLOR,
  createBar,
  createButton,
  createEmpty,
  createIcon,
  createSection,
  createStat,
  createToggle,
  shortenPath,
} from './panel-dom';
import { percentOf, renderBytes, renderRate } from './progress';

/** How many rows a long list shows before it starts counting instead. */
const ROW_LIMIT = 60;

/** How many days the activity chart covers. */
const ACTIVITY_DAYS = 30;

/** `1 file` / `2 files`, without the sentence around it having to care. */
function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** The basename, which is the part of a path that identifies it. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The folder a path is in, with its trailing slash, or empty at the root. */
function folderOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? '' : path.slice(0, cut + 1);
}

const STATE_TONE: Record<BackupState, Tone> = {
  'backed-up': 'good',
  pending: 'warn',
  excluded: 'neutral',
};

/** The mark and colour a change carries in a list. */
const CHANGE_MARK: Record<ChangeKind, { readonly sign: string; readonly tone: Tone }> = {
  add: { sign: '+', tone: 'good' },
  modify: { sign: '~', tone: 'accent' },
  delete: { sign: '−', tone: 'bad' },
  move: { sign: '→', tone: 'neutral' },
  conflict: { sign: '!', tone: 'warn' },
};

const OUTCOME_TONE: Record<RunRecord['outcome'], Tone> = {
  ok: 'good',
  partial: 'warn',
  cancelled: 'neutral',
  failed: 'bad',
};

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

/** The one line at the top that says where the backup stands. */
export function statusLine(ctx: PanelContext): { readonly text: string; readonly tone: Tone } {
  const { progress, host, vault } = ctx;

  if (progress.running) {
    return {
      text: `${progress.label} · ${String(progress.filesDone)} of ${String(progress.filesTotal)}`,
      tone: 'accent',
    };
  }
  if (progress.error !== null) return { text: progress.error.message, tone: 'bad' };
  if (!host.isConnected()) {
    return {
      text: host.hasCredentials()
        ? 'Not connected — sign in to Google Drive'
        : 'Not set up — add your Google OAuth client',
      tone: 'neutral',
    };
  }

  const last = host.runHistory()[0];
  if (vault.pending.length > 0) {
    return {
      text: `${plural(vault.pending.length, 'file', 'files')} · ${formatBytes(vault.pendingBytes)} waiting`,
      tone: 'warn',
    };
  }
  if (last === undefined) return { text: 'Nothing has been pushed yet', tone: 'neutral' };
  return { text: `Everything is in the backup · ${formatAgo(last.at, ctx.now)} ago`, tone: 'good' };
}

/** The title and counter above the body, which change with the tab. */
export function paneHead(ctx: PanelContext, tab: TabId): { title: string; meta: string } {
  const { vault, host, progress } = ctx;

  switch (tab) {
    case 'status':
      if (progress.running) return { title: progress.label, meta: progress.note };
      if (!host.isConnected()) return { title: 'First run', meta: 'not connected' };
      if (vault.pending.length > 0) {
        return { title: 'Changes waiting', meta: formatBytes(vault.pendingBytes) };
      }
      return { title: 'In sync', meta: plural(vault.backedUp, 'file', 'files') };
    case 'diff':
      return {
        title: 'Changes',
        meta:
          ctx.estimate.kind === 'ready'
            ? `checked ${formatWhen(ctx.estimate.at, ctx.now)}`
            : 'local view',
      };
    case 'history':
      return { title: 'History', meta: plural(host.runHistory().length, 'run', 'runs') };
    case 'stats':
      return { title: 'Stats', meta: formatBytes(vault.bytes) };
    case 'excluded':
      return { title: 'Excluded', meta: plural(vault.excluded, 'file', 'files') };
    case 'issues': {
      const count = buildIssues(ctx).length;
      return { title: 'Issues', meta: count === 0 ? 'none' : String(count) };
    }
    case 'settings':
      return { title: 'Settings', meta: '' };
  }
}

/** The line along the bottom: the last run on the left, the vault on the right. */
export function footText(ctx: PanelContext): { left: string; right: string } {
  const { progress, host, vault } = ctx;

  if (progress.running) {
    return {
      left: renderRate(progress, ctx.now) || progress.label,
      right: `${String(progress.filesDone)} / ${String(progress.filesTotal)}`,
    };
  }

  const last = host.runHistory()[0];
  return {
    left:
      last === undefined
        ? `Backing up to “${host.backupFolderName()}”`
        : `${runTitle(last)} · ${formatWhen(last.at, ctx.now)}`,
    right: plural(vault.files, 'file', 'files'),
  };
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

/** Fills `body` with one tab. */
export function renderTab(body: HTMLElement, ctx: PanelContext, tab: TabId): void {
  switch (tab) {
    case 'status':
      renderStatus(body, ctx);
      return;
    case 'diff':
      renderChanges(body, ctx);
      return;
    case 'history':
      renderHistory(body, ctx);
      return;
    case 'stats':
      renderStats(body, ctx);
      return;
    case 'excluded':
      renderExcluded(body, ctx);
      return;
    case 'issues':
      renderIssues(body, ctx);
      return;
    case 'settings':
      renderSettings(body, ctx);
      return;
  }
}

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

function renderStatus(body: HTMLElement, ctx: PanelContext): void {
  const { host, progress, vault } = ctx;
  const ready = host.isConnected() && !host.isBusy();

  const actions = body.createDiv({ cls: 'geode-actions' });
  const push = createButton(actions, {
    text: 'Push',
    variant: 'cta',
    icon: ICONS.push,
    tooltip: 'Send everything the vault has changed to Drive',
    onClick: () => {
      ctx.start('push');
    },
  });
  const pull = createButton(actions, {
    text: 'Pull',
    icon: ICONS.pull,
    tooltip: 'Bring the backup down into this vault',
    onClick: () => {
      ctx.start('pull');
    },
  });
  push.disabled = !ready;
  pull.disabled = !ready;

  if (progress.running) renderRunning(body, ctx);
  else if (!host.isConnected()) renderFirstRun(body, ctx);
  else renderIdle(body, ctx);

  if (!progress.running && progress.error !== null) {
    const card = body.createDiv({ cls: 'geode-card is-bad' });
    const head = card.createDiv({ cls: 'geode-card-head' });
    createIcon(head, ICONS.offline).style.color = TONE_COLOR.bad;
    const text = head.createDiv({ cls: 'geode-card-text' });
    const title = text.createDiv({ cls: 'geode-card-title', text: 'The last run stopped' });
    title.style.color = TONE_COLOR.bad;
    text.createDiv({ cls: 'geode-card-body', text: progress.error.message });

    const buttons = card.createDiv({ cls: 'geode-buttons' });
    createButton(buttons, {
      text: 'Try again',
      variant: 'cta',
      small: true,
      onClick: () => {
        ctx.start('push');
      },
    }).disabled = !ready;
    createButton(buttons, {
      text: 'Settings',
      small: true,
      onClick: () => {
        ctx.go('settings');
      },
    });
  }

  const conflicts = progress.summary?.conflicts ?? [];
  if (conflicts.length > 0) renderConflicts(body, ctx, conflicts);

  const secondary = body.createDiv({ cls: 'geode-secondary' });
  createButton(secondary, {
    text: 'Check what would be pushed',
    hint: plural(vault.pending.length, 'file', 'files'),
    onClick: () => {
      ctx.go('diff');
      ctx.check();
    },
  });
  createButton(secondary, {
    text: 'Show what is excluded',
    hint: plural(vault.excluded, 'file', 'files'),
    onClick: () => {
      ctx.go('excluded');
    },
  });
  createButton(secondary, {
    text: 'Open the run log',
    hint: plural(host.runHistory().length, 'run', 'runs'),
    onClick: () => {
      ctx.go('history');
    },
  });
}

/** The two bars, while something is in flight. */
function renderRunning(body: HTMLElement, ctx: PanelContext): void {
  const { progress } = ctx;
  const card = body.createDiv({ cls: 'geode-card geode-progress' });

  const overall = card.createDiv({ cls: 'geode-progress-block' });
  const head = overall.createDiv({ cls: 'geode-progress-head' });
  head.createSpan({ text: 'Overall' });
  head.createSpan({
    text: `${String(progress.filesDone)} / ${String(progress.filesTotal)}`,
  });

  // Falls back to counting files when the phase moves no bytes, so the bar still
  // means something while the vault is being hashed.
  const percent =
    progress.bytesTotal > 0
      ? percentOf(progress.bytesDone, progress.bytesTotal)
      : percentOf(progress.filesDone, progress.filesTotal);
  createBar(overall).style.width = `${String(percent)}%`;

  const line = overall.createDiv({ cls: 'geode-progress-line' });
  line.createSpan({
    text:
      progress.bytesTotal > 0
        ? `${renderBytes(progress.bytesDone, progress.bytesTotal)} · ${String(percent)}%`
        : `${String(percent)}%`,
  });
  line.createSpan({ text: renderRate(progress, ctx.now) });

  const file = progress.file;
  if (progress.detail.length > 0) {
    const block = card.createDiv({ cls: 'geode-progress-block geode-progress-split' });
    const name = block.createDiv({ cls: 'geode-progress-file', text: progress.detail });
    name.setAttribute('aria-label', shortenPath(progress.detail));

    // Only transfers big enough to be sent in pieces have anything to report
    // here. An empty bar is more honest than a full one that never filled.
    if (file !== null && file.total > 0) {
      const filePercent = percentOf(file.done, file.total);
      createBar(block, true).style.width = `${String(filePercent)}%`;
      block.createDiv({
        cls: 'geode-progress-line',
        text: `${renderBytes(file.done, file.total)} · ${String(filePercent)}%`,
      });
    }
  }

  if (progress.note.length > 0) card.createDiv({ cls: 'geode-card-body', text: progress.note });

  const buttons = card.createDiv({ cls: 'geode-buttons' });
  createButton(buttons, {
    text: ctx.cancelling ? 'Stopping…' : 'Cancel',
    variant: 'danger',
    small: true,
    tooltip: 'Stop after the file being transferred. Everything already moved is kept.',
    onClick: () => {
      ctx.cancel();
    },
    // Cancellation is checked between files, so a run in the middle of a large
    // attachment keeps going for a while. Saying "Stopping…" and meaning it is
    // the only thing that stops the button being pressed again and again.
  }).disabled = ctx.cancelling;
}

/** The four numbers and the recent list, when nothing is running. */
function renderIdle(body: HTMLElement, ctx: PanelContext): void {
  const { vault, host } = ctx;

  const stats = body.createDiv({ cls: 'geode-grid' });
  createStat(stats, String(vault.backedUp), 'in backup');
  createStat(
    stats,
    String(vault.pending.length),
    'to push',
    undefined,
    vault.pending.length > 0 ? 'warn' : 'neutral',
  );
  createStat(stats, formatBytes(vault.includedBytes), 'vault');
  createStat(stats, String(vault.excluded), 'excluded');

  if (host.trackedFileCount() === 0) {
    const card = body.createDiv({ cls: 'geode-card is-dashed' });
    const text = card.createDiv({ cls: 'geode-card-text' });
    text.createDiv({ cls: 'geode-card-title', text: 'This vault has never been pushed' });
    text.createDiv({
      cls: 'geode-card-body',
      text: `${plural(vault.included, 'file', 'files')} · ${formatBytes(vault.includedBytes)} ready for the first upload.`,
    });
    createButton(card, {
      text: 'Push everything now',
      variant: 'cta',
      wide: true,
      onClick: () => {
        ctx.start('push');
      },
    }).disabled = host.isBusy();
    return;
  }

  if (vault.recent.length === 0) return;
  const recent = createSection(body, 'Recently edited');
  const list = recent.createDiv({ cls: 'geode-list' });
  for (const file of vault.recent) {
    const row = list.createDiv({ cls: 'geode-row' });
    row.setAttribute('aria-label', shortenPath(file.path));
    row.createDiv({ cls: 'geode-row-dot' }).style.background = TONE_COLOR[STATE_TONE[file.state]];
    row.createDiv({ cls: 'geode-row-name', text: file.path });
    row.createDiv({ cls: 'geode-row-meta', text: formatAgo(file.mtime, ctx.now) });
  }
}

/** What the panel shows before there is a backup to talk about. */
function renderFirstRun(body: HTMLElement, ctx: PanelContext): void {
  const { host, vault } = ctx;
  const card = body.createDiv({ cls: 'geode-card is-dashed' });

  const text = card.createDiv({ cls: 'geode-card-text' });
  text.createDiv({ cls: 'geode-card-title', text: 'No Google account connected' });
  text.createDiv({
    cls: 'geode-card-body',
    text: `${plural(vault.included, 'file', 'files')} · ${formatBytes(vault.includedBytes)} are ready to go once there is somewhere to send them.`,
  });

  const steps = card.createDiv({ cls: 'geode-steps' });
  const lines: readonly string[] = [
    'Add your own Google OAuth client in the plugin settings',
    'Connect the Google account the backup will live in',
    'Check what would be pushed, then push it',
  ];
  for (const [at, line] of lines.entries()) {
    const step = steps.createDiv({ cls: 'geode-step' });
    step.createDiv({ cls: 'geode-step-n', text: String(at + 1) });
    step.createSpan({ text: line });
  }

  const connect = createButton(card, {
    text: 'Connect Google account',
    variant: 'cta',
    wide: true,
    onClick: () => {
      void host.connectAccount().then(() => {
        ctx.refresh();
      });
    },
  });
  connect.disabled = !host.hasCredentials();

  if (!host.hasCredentials()) {
    card.createDiv({
      cls: 'geode-card-body',
      text: 'The client id and secret live in Settings → Community plugins → GeodeDrive. They stay on this device.',
    });
  }
}

/** Files another device rewrote, which a push reports and steps around. */
function renderConflicts(body: HTMLElement, ctx: PanelContext, conflicts: readonly string[]): void {
  const card = body.createDiv({ cls: 'geode-card is-warn' });

  const head = card.createDiv({ cls: 'geode-card-head' });
  createIcon(head, ICONS.issues).style.color = TONE_COLOR.warn;
  const text = head.createDiv({ cls: 'geode-card-text' });
  text.createDiv({
    cls: 'geode-card-title',
    text: `${plural(conflicts.length, 'file', 'files')} changed on another device`,
  });
  text.createDiv({
    cls: 'geode-card-body',
    text: 'These were left alone. Pull to take the other copy, or edit them here and push again.',
  });

  const list = card.createDiv({ cls: 'geode-list' });
  for (const path of conflicts.slice(0, 4)) {
    const row = list.createDiv({ cls: 'geode-row' });
    row.setAttribute('aria-label', shortenPath(path));
    row.createDiv({ cls: 'geode-row-name', text: path });
  }
  if (conflicts.length > 4) {
    card.createDiv({
      cls: 'geode-card-body',
      text: `…and ${String(conflicts.length - 4)} more.`,
    });
  }

  const buttons = card.createDiv({ cls: 'geode-buttons' });
  createButton(buttons, {
    text: 'Pull the other copy',
    small: true,
    onClick: () => {
      ctx.start('pull');
    },
  }).disabled = ctx.host.isBusy();
  createButton(buttons, {
    text: 'Push again',
    small: true,
    onClick: () => {
      ctx.start('push');
    },
  }).disabled = ctx.host.isBusy();
}

/* -------------------------------------------------------------------------- */
/* Changes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a push would send.
 *
 * Two answers live here, and the difference between them matters. The local one
 * is free and always on screen: files whose bytes are not in the index. The real
 * one costs a walk of the vault and a Drive listing, and is the only one that
 * knows about files another device changed, files that merely moved, and copies
 * a mirroring push would delete.
 */
function renderChanges(body: HTMLElement, ctx: PanelContext): void {
  const { estimate, vault, host } = ctx;

  if (estimate.kind === 'loading') {
    createEmpty(body, 'Checking…', 'Reading the vault and listing the Drive folder.');
    return;
  }

  if (estimate.kind === 'error') {
    const card = body.createDiv({ cls: 'geode-card is-bad' });
    card.createDiv({ cls: 'geode-card-title', text: 'Could not check' });
    card.createDiv({ cls: 'geode-card-body', text: estimate.message });
    createButton(card, {
      text: 'Try again',
      wide: true,
      onClick: () => {
        ctx.check();
      },
    });
    return;
  }

  if (estimate.kind === 'ready') {
    renderPlannedChanges(body, ctx, estimate.value);
    return;
  }

  // Nothing has been checked yet: the local view, clearly labelled as one.
  const local: ChangedFile[] = vault.pending.map((file) => ({
    path: file.path,
    kind: file.kind,
    bytes: file.bytes,
  }));
  if (host.settings.mirrorDeletions) {
    for (const orphan of vault.orphans) {
      local.push({ path: orphan.path, kind: 'delete', bytes: 0 });
    }
  }

  renderChangeLegend(body, ctx, local);
  if (local.length === 0) {
    createEmpty(
      body,
      'Nothing has changed here',
      'Every file the rules let through matches what was last pushed.',
    );
  } else {
    renderChangeList(body, local);
  }

  body.createDiv({
    cls: 'geode-note',
    text: 'This is what this device knows. Checking against Drive also finds files another device changed, files that only moved, and anything the backup holds that the vault no longer does.',
  });
  createButton(body, {
    text: 'Check against Drive',
    variant: 'cta',
    wide: true,
    onClick: () => {
      ctx.check();
    },
  }).disabled = !host.isConnected() || host.isBusy();
}

/** The checked answer: the plan, what Drive holds, and the button that runs it. */
function renderPlannedChanges(
  body: HTMLElement,
  ctx: PanelContext,
  estimate: BackupEstimate,
): void {
  const { changes, push } = estimate;
  renderChangeLegend(body, ctx, changes);

  if (changes.length === 0) {
    createEmpty(body, 'Nothing to push', 'Drive already holds every file the rules let through.');
    renderDriveSpace(body, estimate);
    return;
  }

  renderChangeList(body, changes);
  renderDriveSpace(body, estimate);

  const sending = changes.filter((change) => change.kind === 'add' || change.kind === 'modify');
  createButton(body, {
    text:
      sending.length === 0
        ? `Apply ${plural(changes.length, 'change', 'changes')}`
        : `Push ${plural(sending.length, 'file', 'files')} · ${formatBytes(push.bytes)}`,
    variant: 'cta',
    wide: true,
    onClick: () => {
      ctx.start('push');
    },
  }).disabled = ctx.host.isBusy();
}

/**
 * What the Drive folder holds, and whether there is room for the rest.
 *
 * The free-space line is the one number on this screen that predicts a failure
 * no retry will fix, so a push that cannot fit is said out loud rather than left
 * to be worked out from two figures.
 */
function renderDriveSpace(body: HTMLElement, estimate: BackupEstimate): void {
  const { push, remote, quota } = estimate;
  const note = body.createDiv({ cls: 'geode-note' });
  note.createDiv({
    text: `On Drive: ${plural(remote.files, 'file', 'files')} · ${formatBytes(remote.bytes)}`,
  });

  if (quota === null) {
    note.createDiv({ text: 'Drive space: not reported' });
    return;
  }
  if (quota.limit === null) {
    note.createDiv({ text: `Drive space: ${formatBytes(quota.usage)} used, no limit` });
    return;
  }

  const free = Math.max(0, quota.limit - quota.usage);
  note.createDiv({
    text: `Drive space: ${formatBytes(quota.usage)} of ${formatBytes(quota.limit)} used · ${formatBytes(free)} free`,
  });

  if (push.bytes <= free) return;
  const card = body.createDiv({ cls: 'geode-card is-bad' });
  card.createDiv({ cls: 'geode-card-title', text: 'Not enough room on Drive' });
  card.createDiv({
    cls: 'geode-card-body',
    text: `This push needs ${formatBytes(push.bytes - free)} more than the account has free. It will fail partway through — free some space, or exclude what does not need backing up.`,
  });
}

/** The counters along the top of the list, and the re-check link. */
function renderChangeLegend(
  body: HTMLElement,
  ctx: PanelContext,
  changes: readonly ChangedFile[],
): void {
  const counts = new Map<ChangeKind, number>();
  for (const change of changes) counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);

  const legend = body.createDiv({ cls: 'geode-meter-head' });
  const labels: readonly (readonly [ChangeKind, string])[] = [
    ['add', 'new'],
    ['modify', 'changed'],
    ['delete', 'deleted'],
    ['move', 'moved'],
    ['conflict', 'conflicts'],
  ];

  let shown = 0;
  for (const [kind, label] of labels) {
    const count = counts.get(kind) ?? 0;
    if (count === 0) continue;
    const mark = CHANGE_MARK[kind];
    const span = legend.createSpan({ text: `${mark.sign}${String(count)} ${label}` });
    span.style.color = TONE_COLOR[mark.tone];
    span.style.fontWeight = 'var(--font-semibold)';
    shown += 1;
  }
  if (shown === 0) legend.createSpan({ text: 'no changes' });

  const recheck = legend.createEl('button', { cls: 'geode-link', text: 'Check against Drive' });
  recheck.style.marginLeft = 'auto';
  recheck.disabled = !ctx.host.isConnected() || ctx.host.isBusy();
  recheck.addEventListener('click', () => {
    ctx.check();
  });
}

function renderChangeList(body: HTMLElement, changes: readonly ChangedFile[]): void {
  const list = body.createDiv({ cls: 'geode-list' });

  for (const change of changes.slice(0, ROW_LIMIT)) {
    const mark = CHANGE_MARK[change.kind];
    const row = list.createDiv({ cls: 'geode-row' });
    row.setAttribute('aria-label', shortenPath(change.path));

    const sign = row.createDiv({ cls: 'geode-sign', text: mark.sign });
    sign.style.color = TONE_COLOR[mark.tone];

    const text = row.createDiv({ cls: 'geode-row-text' });
    text.createDiv({ cls: 'geode-row-title', text: baseName(change.path) });
    const folder = folderOf(change.path);
    if (folder.length > 0) text.createDiv({ cls: 'geode-row-sub', text: folder });

    row.createDiv({
      cls: 'geode-row-meta',
      text: change.bytes > 0 ? formatBytes(change.bytes) : '',
    });
  }

  if (changes.length > ROW_LIMIT) {
    list.createDiv({
      cls: 'geode-row-meta',
      text: `…and ${String(changes.length - ROW_LIMIT)} more`,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

function renderHistory(body: HTMLElement, ctx: PanelContext): void {
  const history = ctx.host.runHistory();

  if (history.length === 0) {
    createEmpty(
      body,
      'No runs yet',
      'Every push and pull leaves a line here — what moved, how long it took, and what went wrong.',
    );
    return;
  }

  const list = body.createDiv({ cls: 'geode-list' });
  for (const record of history) {
    const row = list.createDiv({ cls: 'geode-row' });
    row.style.alignItems = 'flex-start';

    const dot = row.createDiv({ cls: 'geode-row-dot' });
    dot.style.background = TONE_COLOR[OUTCOME_TONE[record.outcome]];
    dot.style.marginTop = '6px';

    const text = row.createDiv({ cls: 'geode-row-text' });
    text.style.flex = '1';

    const head = text.createDiv({ cls: 'geode-meter-head' });
    head.createSpan({ text: runTitle(record) }).style.fontWeight = 'var(--font-semibold)';
    head.createSpan({ text: formatWhen(record.at, ctx.now) });

    text.createDiv({ cls: 'geode-row-sub', text: describeRun(record) }).style.direction = 'ltr';

    // The message is the only part a person cannot reconstruct from the counts,
    // so it is spelled out rather than folded into the line above.
    if (record.message.length > 0 && record.outcome !== 'cancelled') {
      text.createDiv({ cls: 'geode-mono', text: record.message }).style.marginTop = '4px';
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Stats                                                                      */
/* -------------------------------------------------------------------------- */

function renderStats(body: HTMLElement, ctx: PanelContext): void {
  const { vault, host } = ctx;

  const cards = body.createDiv({ cls: 'geode-grid' });
  createStat(
    cards,
    String(vault.backedUp),
    'backed up',
    `of ${plural(vault.included, 'file', 'files')}`,
  );
  createStat(
    cards,
    String(vault.orphans.length),
    'orphaned',
    formatBytes(vault.orphanBytes),
    vault.orphans.length > 0 ? 'warn' : 'neutral',
  );
  createStat(cards, formatBytes(vault.bytes), 'vault size', plural(vault.files, 'file', 'files'));
  createStat(cards, String(vault.excluded), 'excluded', formatBytes(vault.excludedBytes));

  renderByType(body, ctx);
  if (vault.orphans.length > 0) renderOrphans(body, ctx);
  if (host.runHistory().length > 0) renderActivity(body, ctx);
}

/** Where the weight is. The answer is almost always one folder of video. */
function renderByType(body: HTMLElement, ctx: PanelContext): void {
  const types = ctx.vault.byType.slice(0, 6);
  if (types.length === 0) return;

  const section = createSection(body, 'By file type');
  const heaviest = types[0]?.bytes ?? 0;

  for (const [at, type] of types.entries()) {
    const meter = section.createDiv({ cls: 'geode-meter' });
    const head = meter.createDiv({ cls: 'geode-meter-head' });
    head.createSpan({
      text: `${type.extension.length === 0 ? 'no extension' : type.extension} · ${plural(type.files, 'file', 'files')}`,
    });
    head.createSpan({ text: formatBytes(type.bytes) });

    const fill = createBar(meter, true);
    fill.style.width = `${String(heaviest > 0 ? Math.max(2, Math.round((type.bytes / heaviest) * 100)) : 0)}%`;
    fill.style.background =
      at === 0 ? TONE_COLOR.accent : at === 1 ? TONE_COLOR.good : 'var(--geode-tx3)';
  }
}

/**
 * What the backup holds that the vault does not.
 *
 * Deleting a note leaves its Drive copy alone unless mirroring is switched on,
 * which is the safe default and also the way a backup quietly fills with things
 * nobody wants back. Listing them is the only way anyone finds out.
 */
function renderOrphans(body: HTMLElement, ctx: PanelContext): void {
  const { vault, host } = ctx;
  const section = createSection(
    body,
    'On Drive, not in the vault',
    `${plural(vault.orphans.length, 'file', 'files')} · ${formatBytes(vault.orphanBytes)}`,
  );

  const list = section.createDiv({ cls: 'geode-list' });
  const shown = 4;

  const draw = (files: typeof vault.orphans): void => {
    for (const orphan of files) {
      const row = list.createDiv({ cls: 'geode-row' });
      row.setAttribute('aria-label', shortenPath(orphan.path));
      row.createDiv({ cls: 'geode-row-name', text: orphan.path });
      row.createDiv({
        cls: 'geode-row-meta',
        text: orphan.bytes > 0 ? formatBytes(orphan.bytes) : '',
      });
    }
  };
  draw(vault.orphans.slice(0, shown));

  if (vault.orphans.length > shown) {
    const more = createButton(section, {
      text: `Show all ${String(vault.orphans.length)}`,
      wide: true,
      small: true,
      onClick: () => {
        draw(vault.orphans.slice(shown));
        more.detach();
      },
    });
  }

  section.createDiv({
    cls: 'geode-note',
    text: host.settings.mirrorDeletions
      ? 'Mirroring is on, so the next push removes these from Drive.'
      : 'Mirroring is off, so these stay on Drive. Turn it on in Settings if you want deletions to follow.',
  });
}

/** Bytes uploaded per day, from the run log. */
function renderActivity(body: HTMLElement, ctx: PanelContext): void {
  const days = dailyBytes(ctx.host.runHistory(), ACTIVITY_DAYS, ctx.now);
  const peak = Math.max(...days);
  const section = createSection(body, `Moved, last ${String(ACTIVITY_DAYS)} days`);

  const chart = section.createDiv({ cls: 'geode-chart' });
  for (const [at, bytes] of days.entries()) {
    const bar = chart.createDiv({ cls: 'geode-chart-bar' });
    bar.style.height = `${String(peak > 0 ? Math.max(3, Math.round((bytes / peak) * 100)) : 3)}%`;
    bar.setAttribute(
      'aria-label',
      `${String(days.length - 1 - at)} days ago · ${formatBytes(bytes)}`,
    );
  }

  const axis = section.createDiv({ cls: 'geode-chart-axis' });
  axis.createSpan({ text: `${String(ACTIVITY_DAYS)} days ago` });
  axis.createSpan({ text: 'today' });
}

/* -------------------------------------------------------------------------- */
/* Excluded                                                                   */
/* -------------------------------------------------------------------------- */

function renderExcluded(body: HTMLElement, ctx: PanelContext): void {
  const { vault, host, rules } = ctx;

  const form = body.createDiv({ cls: 'geode-buttons' });
  const input = form.createEl('input', {
    cls: 'geode-input',
    attr: { type: 'text', placeholder: 'zzz_attachments/**/*.mp4', 'aria-label': 'New rule' },
  });
  const add = (): void => {
    ctx.addRule(input.value);
    input.value = '';
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') add();
  });
  createButton(form, { text: 'Add', variant: 'cta', small: true, onClick: add }).addClass(
    'is-narrow',
  );

  if (rules === null) {
    createEmpty(body, 'Reading the rules…');
    return;
  }

  if (rules.length === 0) {
    createEmpty(
      body,
      'No rules yet',
      'Nothing is kept out of the backup. Add a rule above, in .gitignore syntax.',
    );
  } else {
    renderRuleList(body, ctx, rules);
  }

  body.createDiv({
    cls: 'geode-note',
    text:
      vault.excluded === 0
        ? `Nothing is excluded — all ${plural(vault.files, 'file', 'files')} would be backed up.`
        : `${String(vault.excluded)} of ${plural(vault.files, 'file', 'files')} · ${formatBytes(vault.excludedBytes)} never leaves this device.`,
  });

  createButton(body, {
    text: 'Show the full tree',
    wide: true,
    onClick: () => {
      host.showExcluded();
    },
  });
}

function renderRuleList(body: HTMLElement, ctx: PanelContext, rules: readonly RuleLine[]): void {
  const list = body.createDiv({ cls: 'geode-list' });

  for (const rule of rules) {
    const row = list.createDiv({ cls: 'geode-row' });
    row.style.alignItems = 'center';

    createToggle(
      row,
      rule.enabled,
      `Rule ${rule.pattern}`,
      // A rule the vault's own .gitignore wrote is not ours to comment out.
      // Switching those off is what the "Use the vault's .gitignore" setting is.
      rule.source === 'gitignore'
        ? null
        : (next) => {
            ctx.toggleRule(rule, next);
          },
    );

    const text = row.createDiv({ cls: 'geode-row-text' });
    const pattern = text.createDiv({ cls: 'geode-row-title', text: rule.pattern });
    pattern.style.fontFamily = 'var(--font-monospace)';
    if (!rule.enabled) pattern.style.textDecoration = 'line-through';
    text.createDiv({
      cls: 'geode-row-sub',
      text: rule.source === 'gitignore' ? 'from .gitignore' : 'from settings',
    }).style.direction = 'ltr';

    const meta = row.createDiv({
      cls: 'geode-row-meta',
      text: rule.negated
        ? `brings back ${String(rule.matched)}`
        : `${String(rule.matched)} · ${formatBytes(rule.bytes)}`,
    });
    if (!rule.enabled) meta.style.opacity = '0.6';
  }
}

/* -------------------------------------------------------------------------- */
/* Issues                                                                     */
/* -------------------------------------------------------------------------- */

/** Something the user should decide about. */
export interface Issue {
  readonly title: string;
  readonly body: string;
  readonly when: string;
  readonly tone: Tone;
  readonly actions: readonly { readonly label: string; readonly run: () => void }[];
}

/**
 * Everything currently wrong, worst first.
 *
 * Derived rather than stored: an issue that has been fixed should stop being an
 * issue the moment it is fixed, and a list that has to be dismissed to go away
 * is a list that gets dismissed without being read.
 */
export function buildIssues(ctx: PanelContext): Issue[] {
  const { host, progress, vault } = ctx;
  const issues: Issue[] = [];
  const last = host.runHistory()[0];

  if (!host.hasCredentials()) {
    issues.push({
      title: 'No Google OAuth client',
      body: 'Geode talks to your own Google project, so it needs a client id and secret. They live in the plugin settings and stay on this device.',
      when: 'setup',
      tone: 'bad',
      actions: [
        {
          label: 'Open settings',
          run: () => {
            ctx.go('settings');
          },
        },
      ],
    });
  } else if (!host.isConnected()) {
    issues.push({
      title: 'Not connected to Google Drive',
      body: 'Nothing can be pushed or pulled until an account is connected.',
      when: 'setup',
      tone: 'bad',
      actions: [
        {
          label: 'Connect',
          run: () => {
            void host.connectAccount().then(() => {
              ctx.refresh();
            });
          },
        },
      ],
    });
  }

  if (host.isEncryptionLocked()) {
    issues.push({
      title: 'Encryption is locked',
      body: 'The passphrase has not been entered this session. The next push will ask for it before it sends anything encrypted.',
      when: 'now',
      tone: 'warn',
      actions: [
        {
          label: 'Push and unlock',
          run: () => {
            ctx.start('push');
          },
        },
      ],
    });
  }

  const failures = progress.summary?.failures ?? [];
  if (failures.length > 0) {
    const sample = failures
      .slice(0, 3)
      .map((failure) => `${baseName(failure.path)}: ${failure.message}`)
      .join('\n');
    issues.push({
      title: `${plural(failures.length, 'file', 'files')} failed`,
      body: sample,
      when: last === undefined ? 'last run' : formatWhen(last.at, ctx.now),
      tone: 'bad',
      actions: [
        {
          label: 'Try again',
          run: () => {
            ctx.start('push');
          },
        },
        {
          label: 'History',
          run: () => {
            ctx.go('history');
          },
        },
      ],
    });
  }

  const conflicts = progress.summary?.conflicts ?? [];
  if (conflicts.length > 0) {
    issues.push({
      title: `${plural(conflicts.length, 'file', 'files')} changed on another device`,
      body: `${conflicts.slice(0, 3).join('\n')}${conflicts.length > 3 ? `\n…and ${String(conflicts.length - 3)} more` : ''}`,
      when: last === undefined ? 'last run' : formatWhen(last.at, ctx.now),
      tone: 'warn',
      actions: [
        {
          label: 'Pull first',
          run: () => {
            ctx.start('pull');
          },
        },
        {
          label: 'Changes',
          run: () => {
            ctx.go('diff');
          },
        },
      ],
    });
  }

  for (const warning of progress.summary?.warnings ?? []) {
    issues.push({
      title: 'Worth knowing',
      body: warning,
      when: last === undefined ? 'last run' : formatWhen(last.at, ctx.now),
      tone: 'warn',
      actions: [],
    });
  }

  if (progress.error !== null) {
    issues.push({
      title: 'The last run stopped',
      body: progress.error.message,
      when: 'last run',
      tone: progress.error.kind === 'cancelled' ? 'neutral' : 'bad',
      actions: [
        {
          label: 'Try again',
          run: () => {
            ctx.start('push');
          },
        },
      ],
    });
  }

  if (vault.orphans.length > 0) {
    issues.push({
      title: `${plural(vault.orphans.length, 'file', 'files')} only on Drive`,
      body: `${formatBytes(vault.orphanBytes)} the backup still holds and this vault no longer has. Harmless, but it is space.`,
      when: 'now',
      tone: 'neutral',
      actions: [
        {
          label: 'Review',
          run: () => {
            ctx.go('stats');
          },
        },
      ],
    });
  }

  return issues;
}

function renderIssues(body: HTMLElement, ctx: PanelContext): void {
  const issues = buildIssues(ctx);

  if (issues.length === 0) {
    createEmpty(body, 'Nothing needs attention', 'No failures, no conflicts, nothing left behind.');
    return;
  }

  for (const issue of issues) {
    const card = body.createDiv({ cls: 'geode-card' });
    if (issue.tone === 'bad') card.addClass('is-bad');
    if (issue.tone === 'warn') card.addClass('is-warn');

    const head = card.createDiv({ cls: 'geode-meter-head' });
    const dot = head.createSpan({ cls: 'geode-row-dot' });
    dot.style.background = TONE_COLOR[issue.tone];
    head.createSpan({ text: issue.title }).style.fontWeight = 'var(--font-semibold)';
    head.createSpan({ text: issue.when });

    card.createDiv({ cls: 'geode-card-body', text: issue.body }).style.whiteSpace = 'pre-wrap';

    if (issue.actions.length === 0) continue;
    const buttons = card.createDiv({ cls: 'geode-buttons' });
    for (const action of issue.actions) {
      createButton(buttons, { text: action.label, small: true, onClick: action.run });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

/** One row of the Settings tab. */
interface SettingRow {
  readonly name: string;
  readonly desc: string;
  readonly control:
    | { readonly kind: 'toggle'; readonly on: boolean; readonly set: (next: boolean) => void }
    | { readonly kind: 'value'; readonly text: string }
    | { readonly kind: 'action'; readonly text: string; readonly run: () => void };
}

/**
 * The settings worth reaching without leaving the panel.
 *
 * Not all of them: the OAuth client is two long secrets with a page of
 * instructions attached, and the exclusion list is a text area. Those stay where
 * there is room for them, and this tab says so rather than pretending they do
 * not exist.
 */
function renderSettings(body: HTMLElement, ctx: PanelContext): void {
  const { host } = ctx;
  const settings = host.settings;

  const groups: readonly (readonly [string, readonly SettingRow[]])[] = [
    [
      'Google Drive',
      [
        {
          name: 'Account',
          desc: host.isConnected() ? 'A refresh token is stored on this device' : 'Not connected',
          control: {
            kind: 'action',
            text: host.isConnected() ? 'Reconnect' : 'Connect',
            run: () => {
              void host.connectAccount().then(() => {
                ctx.refresh();
              });
            },
          },
        },
        {
          name: 'Backup folder',
          desc: 'The folder on Drive the vault is copied into',
          control: { kind: 'value', text: host.backupFolderName() },
        },
        {
          name: 'Sign-in flow',
          desc: 'How the Google account is authorised',
          control: { kind: 'value', text: settings.authFlow === 'pkce' ? 'PKCE' : 'Device code' },
        },
      ],
    ],
    [
      'What gets backed up',
      [
        {
          name: "Use the vault's .gitignore",
          desc: 'Skip whatever the repository already excludes',
          control: {
            kind: 'toggle',
            on: settings.useGitignore,
            set: (next) => {
              ctx.update((current) => {
                current.useGitignore = next;
              });
            },
          },
        },
        {
          name: 'Exclusion rules',
          desc: 'Extra .gitignore-style lines of your own',
          control: {
            kind: 'action',
            text: plural(settings.excludedPaths.length, 'rule', 'rules'),
            run: () => {
              ctx.go('excluded');
            },
          },
        },
        {
          name: 'Mirror deletions',
          desc: 'Let a file deleted here be deleted from Drive too',
          control: {
            kind: 'toggle',
            on: settings.mirrorDeletions,
            set: (next) => {
              ctx.update((current) => {
                current.mirrorDeletions = next;
              });
            },
          },
        },
      ],
    ],
    [
      'Encryption',
      [
        {
          name: 'Encrypt before upload',
          desc: 'Files are sealed on this device; Google never sees the contents',
          control: {
            kind: 'toggle',
            on: settings.encryptionEnabled,
            set: (next) => {
              ctx.update((current) => {
                current.encryptionEnabled = next;
              });
            },
          },
        },
        {
          name: 'Encrypted paths',
          desc:
            settings.encryptedPrefixes.length === 0
              ? 'Everything, when encryption is on'
              : 'Only these path prefixes',
          control: {
            kind: 'value',
            text:
              settings.encryptedPrefixes.length === 0
                ? 'all files'
                : plural(settings.encryptedPrefixes.length, 'prefix', 'prefixes'),
          },
        },
        {
          name: 'Ask for the passphrase',
          desc: 'How often the key has to be typed again',
          control: {
            kind: 'value',
            text: settings.passphrasePrompt === 'every-operation' ? 'every run' : 'once a session',
          },
        },
      ],
    ],
    [
      'This panel',
      [
        {
          name: 'Mark files in the explorer',
          desc: 'A dot on every file saying whether it is in the backup',
          control: {
            kind: 'toggle',
            on: settings.showFileBadges,
            set: (next) => {
              ctx.update((current) => {
                current.showFileBadges = next;
              });
            },
          },
        },
      ],
    ],
  ];

  for (const [title, rows] of groups) {
    const section = createSection(body, title);
    for (const row of rows) {
      const setting = section.createDiv({ cls: 'geode-setting' });
      const text = setting.createDiv({ cls: 'geode-setting-text' });
      text.createDiv({ cls: 'geode-setting-name', text: row.name });
      text.createDiv({ cls: 'geode-setting-desc', text: row.desc });

      const control = setting.createDiv({ cls: 'geode-setting-control' });
      switch (row.control.kind) {
        case 'toggle': {
          const { on, set } = row.control;
          createToggle(control, on, row.name, set);
          break;
        }
        case 'value':
          control.createDiv({ cls: 'geode-value', text: row.control.text });
          break;
        case 'action': {
          const { text: label, run } = row.control;
          createButton(control, { text: label, small: true, onClick: run });
          break;
        }
      }
    }
  }

  body.createDiv({
    cls: 'geode-note',
    text: 'The OAuth client, the exclusion text area and the encryption passphrase rules live in Settings → Community plugins → GeodeDrive.',
  });
}
