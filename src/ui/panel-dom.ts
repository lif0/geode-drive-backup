/**
 * The panel's building blocks: a stylesheet, and the handful of shapes every tab
 * is made of.
 *
 * Written as classes and one stylesheet rather than as inline styles, because
 * half of what the design asks for — hover, focus, the active tab — cannot be
 * expressed by setting `element.style` at all, and because a sidebar that
 * hardcodes colours is a sidebar that looks wrong in every theme but the one it
 * was drawn in. Everything here resolves to Obsidian's own variables, so the
 * panel follows the user's theme, their accent colour and their font scale
 * without knowing any of them.
 *
 * The stylesheet is injected from TypeScript, the way `file-badges.ts` does it,
 * so the plugin still ships as main.js and manifest.json.
 */

/** Every icon the panel draws, as SVG path data. */
export const ICONS = {
  vault: ['M3 7l9-4 9 4-9 4-9-4z', 'M3 12l9 4 9-4', 'M3 17l9 4 9-4'],
  push: ['M12 19V5M5 12l7-7 7 7'],
  pull: ['M12 5v14M5 12l7 7 7-7'],
  status: ['M12 19V5M5 12l7-7 7 7'],
  diff: ['M9 4L5 8l4 4M5 8h9a4 4 0 014 4v4M15 20l4-4-4-4'],
  history: ['M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18'],
  stats: ['M4 20V10M10 20V4M16 20v-7M21 20H3'],
  excluded: ['M3 5h18l-7 8v6l-4-2v-4L3 5z'],
  issues: [
    'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  ],
  settings: ['M4 7h16M4 17h16M9 4v6M15 14v6'],
  offline: [
    'M1 1l22 22M16.7 11.7A6 6 0 0119 16M5 12.5a10 10 0 014-2.4M2 8.8a15 15 0 015-3.3M12 20h.01',
  ],
} as const;

/** The tones a card, a dot or a number can carry. */
export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad';

/** The CSS variable each tone resolves to, for the few things drawn inline. */
export const TONE_COLOR: Record<Tone, string> = {
  neutral: 'var(--geode-tx3)',
  accent: 'var(--geode-accent)',
  good: 'var(--geode-good)',
  warn: 'var(--geode-warn)',
  bad: 'var(--geode-bad)',
};

/**
 * The stylesheet.
 *
 * The variable block at the top is the whole theme story: the design's palette
 * mapped onto Obsidian's, once, so nothing below ever names a colour.
 */
export const PANEL_STYLES = `
.workspace-leaf-content[data-type='geode-progress'] .view-content {
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.geode-panel {
  --geode-accent: var(--interactive-accent);
  --geode-on-accent: var(--text-on-accent);
  /* A card is drawn on the primary background and the panel on the secondary,
     which is the pair that keeps them apart in a light theme as well as a dark
     one — background-primary-alt sits the wrong side of primary in one of the
     two, and the cards disappear. */
  --geode-surface: var(--background-secondary);
  --geode-raised: var(--background-primary);
  --geode-hover: var(--background-modifier-hover);
  --geode-border: var(--background-modifier-border);
  --geode-track: var(--background-modifier-border);
  --geode-tx: var(--text-normal);
  --geode-tx2: var(--text-muted);
  --geode-tx3: var(--text-faint);
  --geode-good: var(--color-green);
  --geode-warn: var(--color-orange);
  --geode-bad: var(--color-red);
  --geode-good-bg: color-mix(in srgb, var(--color-green) 9%, transparent);
  --geode-warn-bg: color-mix(in srgb, var(--color-orange) 9%, transparent);
  --geode-warn-bd: color-mix(in srgb, var(--color-orange) 32%, transparent);
  --geode-bad-bg: color-mix(in srgb, var(--color-red) 9%, transparent);
  --geode-bad-bd: color-mix(in srgb, var(--color-red) 32%, transparent);
  --geode-accent-bg: color-mix(in srgb, var(--interactive-accent) 15%, transparent);

  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* Named rather than inherited, so the cards keep their contrast even if the
     panel is dragged out of the sidebar and into the main editor area. */
  background: var(--background-secondary);
  color: var(--geode-tx);
  font-size: var(--font-ui-small);
  line-height: 1.5;
}

/* ------------------------------- header --------------------------------- */

.geode-head {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--geode-border);
}
.geode-vault {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.geode-vault svg { flex: none; color: var(--geode-tx3); }
.geode-vault-name {
  font-weight: var(--font-semibold);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.geode-vault-meta {
  margin-left: auto;
  flex: none;
  font-size: var(--font-ui-smaller);
  color: var(--geode-tx3);
  font-variant-numeric: tabular-nums;
}
.geode-status {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 9px;
  border-radius: 6px;
  background: var(--geode-raised);
  border: 1px solid var(--geode-border);
}
.geode-status-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 99px;
  background: var(--geode-tx3);
}
.geode-status-text {
  font-size: var(--font-ui-smaller);
  color: var(--geode-tx2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* -------------------------------- tabs ---------------------------------- */

.geode-tabs {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--geode-border);
}
.geode-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--geode-tx3);
  box-shadow: none;
  cursor: pointer;
}
.geode-tab:hover { background: var(--geode-hover); color: var(--geode-tx2); }
.geode-tab.is-active { background: var(--geode-accent-bg); color: var(--geode-accent); }
.geode-tab-mark {
  position: absolute;
  margin: -10px 0 0 14px;
  width: 5px;
  height: 5px;
  border-radius: 99px;
  background: var(--geode-warn);
}

/* -------------------------------- body ---------------------------------- */

.geode-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.geode-pane-head { display: flex; align-items: baseline; gap: 8px; }
.geode-pane-title {
  margin: 0;
  min-width: 0;
  font-size: var(--font-ui-medium);
  font-weight: var(--font-semibold);
  letter-spacing: -0.01em;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.geode-pane-meta {
  margin-left: auto;
  flex: none;
  /* Capped, because the meta on the Status tab is whatever the run last had to
     say, and a long note must not push the title off its own line. */
  max-width: 55%;
  font-size: var(--font-ui-smaller);
  color: var(--geode-tx3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.geode-stack { display: flex; flex-direction: column; gap: 12px; }
.geode-section { display: flex; flex-direction: column; gap: 8px; }
.geode-section-title {
  font-size: var(--font-ui-smaller);
  color: var(--geode-tx3);
  text-transform: uppercase;
  letter-spacing: .05em;
  font-weight: var(--font-semibold);
}
.geode-section-head { display: flex; align-items: baseline; gap: 6px; }
.geode-section-head .geode-pane-meta { font-size: var(--font-ui-smaller); }

/* ------------------------------- buttons -------------------------------- */

.geode-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.geode-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--geode-border);
  border-radius: 6px;
  background: var(--geode-raised);
  color: var(--geode-tx);
  font-size: var(--font-ui-small);
  cursor: pointer;
  box-shadow: none;
}
.geode-btn:hover:not(:disabled) { background: var(--geode-hover); }
.geode-btn:disabled { opacity: .5; cursor: default; }
.geode-btn.is-cta {
  border-color: transparent;
  background: var(--geode-accent);
  color: var(--geode-on-accent);
  font-weight: var(--font-semibold);
}
.geode-btn.is-cta:hover:not(:disabled) { filter: brightness(1.08); background: var(--geode-accent); }
.geode-btn.is-danger { background: transparent; border-color: var(--geode-bad-bd); color: var(--geode-bad); }
.geode-btn.is-danger:hover:not(:disabled) { background: var(--geode-bad-bg); }
.geode-btn.is-small { height: 27px; font-size: var(--font-ui-smaller); }
.geode-btn.is-wide { width: 100%; }
.geode-btn.is-quiet { background: transparent; color: var(--geode-tx2); }
.geode-btn.is-quiet:hover:not(:disabled) { background: var(--geode-hover); color: var(--geode-tx); }

.geode-secondary { display: flex; flex-direction: column; gap: 4px; }
.geode-secondary .geode-btn {
  height: 31px;
  justify-content: flex-start;
  background: transparent;
  color: var(--geode-tx2);
  font-size: var(--font-ui-smaller);
}
.geode-secondary .geode-btn:hover:not(:disabled) { background: var(--geode-raised); color: var(--geode-tx); }
.geode-secondary .geode-btn > span:first-child {
  flex: 1;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.geode-btn-hint { flex: none; font-size: var(--font-ui-smaller); color: var(--geode-tx3); font-variant-numeric: tabular-nums; }

.geode-link {
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 0;
  height: auto;
  width: auto;
  color: var(--geode-accent);
  font-size: var(--font-ui-smaller);
  cursor: pointer;
}
.geode-link:hover { text-decoration: underline; background: transparent; }
.geode-link:disabled { opacity: .5; cursor: default; text-decoration: none; }

/* -------------------------------- cards --------------------------------- */

.geode-card {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 11px 12px;
  border-radius: 8px;
  background: var(--geode-raised);
  border: 1px solid var(--geode-border);
}
.geode-card.is-warn { background: var(--geode-warn-bg); border-color: var(--geode-warn-bd); }
.geode-card.is-bad { background: var(--geode-bad-bg); border-color: var(--geode-bad-bd); }
.geode-card.is-dashed { border-style: dashed; }
.geode-card-head { display: flex; gap: 8px; align-items: flex-start; }
.geode-card-head svg { flex: none; margin-top: 2px; }
.geode-card-title { font-size: var(--font-ui-smaller); font-weight: var(--font-semibold); }
.geode-card-body { font-size: var(--font-ui-smaller); color: var(--geode-tx2); }
.geode-card-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }

.geode-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.geode-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 10px;
  border-radius: 7px;
  background: var(--geode-raised);
  border: 1px solid var(--geode-border);
}
.geode-stat-value {
  font-size: 1.15em;
  font-weight: var(--font-semibold);
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
}
.geode-stat-label {
  font-size: var(--font-ui-smaller);
  color: var(--geode-tx3);
  text-transform: uppercase;
  letter-spacing: .04em;
}
.geode-stat-sub { font-size: var(--font-ui-smaller); color: var(--geode-tx2); }

/* -------------------------------- rows ---------------------------------- */

.geode-list { display: flex; flex-direction: column; gap: 1px; }
.geode-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 5px;
  min-width: 0;
}
.geode-row:hover { background: var(--geode-raised); }
.geode-row-dot { width: 5px; height: 5px; flex: none; border-radius: 99px; }
.geode-row-name {
  font-size: var(--font-ui-smaller);
  color: var(--geode-tx2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
.geode-row-meta {
  margin-left: auto;
  flex: none;
  font-size: var(--font-ui-smaller);
  color: var(--geode-tx3);
  font-variant-numeric: tabular-nums;
}
.geode-row-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.geode-row-title {
  font-size: var(--font-ui-smaller);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.geode-row-sub {
  font-size: var(--font-ui-smaller);
  color: var(--geode-tx3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
.geode-sign {
  flex: none;
  width: 14px;
  text-align: center;
  font-family: var(--font-monospace);
  font-weight: var(--font-bold);
}

/* -------------------------------- bars ---------------------------------- */

.geode-bar {
  height: 6px;
  border-radius: 99px;
  background: var(--geode-track);
  overflow: hidden;
}
.geode-bar.is-thin { height: 4px; }
.geode-bar-fill {
  height: 100%;
  width: 0;
  border-radius: 99px;
  background: var(--geode-accent);
  transition: width 150ms linear;
}
.geode-meter { display: flex; flex-direction: column; gap: 4px; }
.geode-meter-head { display: flex; gap: 8px; font-size: var(--font-ui-smaller); }
.geode-meter-head > span:last-child { margin-left: auto; color: var(--geode-tx3); font-variant-numeric: tabular-nums; }

.geode-chart { display: flex; align-items: flex-end; gap: 3px; height: 52px; }
.geode-chart-bar {
  flex: 1;
  min-width: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--geode-accent);
  opacity: .55;
}
.geode-chart-bar:hover { opacity: 1; }
.geode-chart-axis { display: flex; font-size: var(--font-ui-smaller); color: var(--geode-tx3); }
.geode-chart-axis > span:last-child { margin-left: auto; }

/* ------------------------------- progress ------------------------------- */

.geode-progress { display: flex; flex-direction: column; gap: 12px; }
.geode-progress-block { display: flex; flex-direction: column; gap: 6px; }
.geode-progress-split { padding-top: 10px; border-top: 1px solid var(--geode-border); }
.geode-progress-head { display: flex; align-items: baseline; gap: 8px; font-size: var(--font-ui-smaller); }
.geode-progress-head > span:first-child { font-weight: var(--font-semibold); }
.geode-progress-head > span:last-child { margin-left: auto; color: var(--geode-tx2); font-variant-numeric: tabular-nums; }
.geode-progress-line {
  display: flex;
  gap: 8px;
  font-size: var(--font-ui-smaller);
  color: var(--geode-tx2);
  font-variant-numeric: tabular-nums;
}
.geode-progress-line > span:last-child { margin-left: auto; text-align: right; }
.geode-progress-file {
  font-size: var(--font-ui-smaller);
  color: var(--geode-tx2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}
.geode-buttons { display: flex; gap: 6px; }
.geode-buttons > * { flex: 1; }
.geode-buttons > .is-narrow { flex: none; }

/* ------------------------------ misc bits ------------------------------- */

.geode-mono {
  font-family: var(--font-monospace);
  font-size: var(--font-ui-smaller);
  color: var(--geode-tx3);
  background: var(--geode-surface);
  border: 1px solid var(--geode-border);
  border-radius: 5px;
  padding: 7px 8px;
  white-space: pre-wrap;
  word-break: break-word;
}
.geode-note {
  padding: 9px 10px;
  border-radius: 7px;
  background: var(--geode-raised);
  border: 1px solid var(--geode-border);
  font-size: var(--font-ui-smaller);
  color: var(--geode-tx2);
}
.geode-empty {
  display: flex;
  flex-direction: column;
  gap: 3px;
  align-items: center;
  text-align: center;
  padding: 22px 10px;
  color: var(--geode-tx3);
}
.geode-empty-title { font-size: var(--font-ui-small); color: var(--geode-tx2); font-weight: var(--font-semibold); }
.geode-empty-body { font-size: var(--font-ui-smaller); }
.geode-steps { display: flex; flex-direction: column; gap: 7px; }
.geode-step { display: flex; gap: 8px; align-items: center; font-size: var(--font-ui-smaller); color: var(--geode-tx2); }
.geode-step-n {
  width: 18px;
  height: 18px;
  flex: none;
  border-radius: 99px;
  background: var(--geode-hover);
  color: var(--geode-tx2);
  font-size: var(--font-ui-smaller);
  font-weight: var(--font-semibold);
  display: flex;
  align-items: center;
  justify-content: center;
}

.geode-input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 9px;
  border-radius: 6px;
  border: 1px solid var(--geode-border);
  background: var(--geode-raised);
  color: var(--geode-tx);
  font-size: var(--font-ui-smaller);
  font-family: var(--font-monospace);
}

.geode-toggle {
  width: 28px;
  height: 16px;
  flex: none;
  border: none;
  border-radius: 99px;
  background: var(--geode-hover);
  position: relative;
  padding: 0;
  cursor: pointer;
  box-shadow: none;
}
.geode-toggle::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 99px;
  background: var(--geode-tx3);
  transition: left 150ms ease, background 150ms ease;
}
.geode-toggle.is-on { background: var(--geode-accent); }
.geode-toggle.is-on::after { left: 14px; background: var(--geode-on-accent); }
.geode-toggle:disabled { opacity: .45; cursor: default; }

.geode-setting {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--geode-border);
}
.geode-setting:last-child { border-bottom: none; }
.geode-setting-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.geode-setting-name { font-size: var(--font-ui-smaller); }
.geode-setting-desc { font-size: var(--font-ui-smaller); color: var(--geode-tx3); }
.geode-setting-control { margin-left: auto; flex: none; display: flex; align-items: center; gap: 6px; }
.geode-value {
  display: block;
  padding: 4px 9px;
  border-radius: 5px;
  border: 1px solid var(--geode-border);
  background: var(--geode-raised);
  font-size: var(--font-ui-smaller);
  color: var(--geode-tx2);
  white-space: nowrap;
}

/* ------------------------------- footer --------------------------------- */

.geode-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 11px;
  border-top: 1px solid var(--geode-border);
  background: var(--geode-raised);
  font-size: var(--font-ui-smaller);
  color: var(--geode-tx3);
  font-variant-numeric: tabular-nums;
}
.geode-foot > span:first-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.geode-foot > span:last-child { margin-left: auto; flex: none; }
`;

/** Draws one of the `ICONS` entries into `parent`. */
export function createIcon(
  parent: HTMLElement,
  paths: readonly string[],
  size = 15,
): SVGSVGElement {
  const svg = parent.createSvg('svg', {
    attr: {
      width: String(size),
      height: String(size),
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
  });
  for (const path of paths) svg.createSvg('path', { attr: { d: path } });
  return svg;
}

/** Options for `createButton`. */
export interface ButtonOptions {
  readonly text: string;
  readonly variant?: 'cta' | 'danger' | 'quiet' | 'plain';
  readonly icon?: readonly string[];
  /** A right-aligned counter or shortcut, as the secondary actions use. */
  readonly hint?: string;
  readonly small?: boolean;
  readonly wide?: boolean;
  readonly tooltip?: string;
  readonly onClick: () => void;
}

/** A button in the panel's own style. */
export function createButton(parent: HTMLElement, options: ButtonOptions): HTMLButtonElement {
  const button = parent.createEl('button', { cls: 'geode-btn' });
  if (options.variant === 'cta') button.addClass('is-cta');
  if (options.variant === 'danger') button.addClass('is-danger');
  if (options.variant === 'quiet') button.addClass('is-quiet');
  if (options.small === true) button.addClass('is-small');
  if (options.wide === true) button.addClass('is-wide');
  if (options.icon !== undefined) createIcon(button, options.icon, 14);

  button.createSpan({ text: options.text });
  if (options.hint !== undefined) button.createSpan({ cls: 'geode-btn-hint', text: options.hint });
  if (options.tooltip !== undefined) button.setAttribute('aria-label', options.tooltip);

  button.addEventListener('click', options.onClick);
  return button;
}

/**
 * A switch.
 *
 * A button rather than a checkbox so it can be focused, pressed with the
 * keyboard and read out as what it is, which a styled `div` cannot.
 */
export function createToggle(
  parent: HTMLElement,
  on: boolean,
  label: string,
  onChange: ((next: boolean) => void) | null,
): HTMLButtonElement {
  const toggle = parent.createEl('button', { cls: 'geode-toggle' });
  toggle.toggleClass('is-on', on);
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', on ? 'true' : 'false');
  toggle.setAttribute('aria-label', label);

  if (onChange === null) {
    toggle.disabled = true;
    return toggle;
  }
  toggle.addEventListener('click', () => {
    onChange(!on);
  });
  return toggle;
}

/** A track with a fill inside it. The fill is what moves. */
export function createBar(parent: HTMLElement, thin = false): HTMLElement {
  const track = parent.createDiv({ cls: thin ? 'geode-bar is-thin' : 'geode-bar' });
  return track.createDiv({ cls: 'geode-bar-fill' });
}

/** A labelled number, as the Status and Stats tabs stack them. */
export function createStat(
  parent: HTMLElement,
  value: string,
  label: string,
  sub?: string,
  tone: Tone = 'neutral',
): HTMLElement {
  const stat = parent.createDiv({ cls: 'geode-stat' });
  const number = stat.createDiv({ cls: 'geode-stat-value', text: value });
  if (tone !== 'neutral') number.style.color = TONE_COLOR[tone];
  stat.createDiv({ cls: 'geode-stat-label', text: label });
  if (sub !== undefined) stat.createDiv({ cls: 'geode-stat-sub', text: sub });
  return stat;
}

/** A titled block. Returns the body, for the caller to fill. */
export function createSection(parent: HTMLElement, title: string, meta?: string): HTMLElement {
  const section = parent.createDiv({ cls: 'geode-section' });
  if (meta === undefined) {
    section.createDiv({ cls: 'geode-section-title', text: title });
    return section;
  }

  const head = section.createDiv({ cls: 'geode-section-head' });
  head.createDiv({ cls: 'geode-section-title', text: title });
  head.createDiv({ cls: 'geode-pane-meta', text: meta });
  return section;
}

/** What a tab shows when it has nothing to show. */
export function createEmpty(parent: HTMLElement, title: string, body?: string): HTMLElement {
  const empty = parent.createDiv({ cls: 'geode-empty' });
  empty.createDiv({ cls: 'geode-empty-title', text: title });
  if (body !== undefined) empty.createDiv({ cls: 'geode-empty-body', text: body });
  return empty;
}

/**
 * A path, trimmed from the left.
 *
 * The end of a path is the part that identifies it, so the rows that show one
 * are laid out right-to-left and lose their beginning rather than their name.
 * This is the fallback for the places that cannot do that — a tooltip, a log.
 */
export function shortenPath(path: string, max = 60): string {
  if (path.length <= max) return path;
  return `…${path.slice(path.length - max + 1)}`;
}
