/**
 * What the panel needs from the plugin, and what its tabs need from each other.
 *
 * Declared away from both so the view and the tab renderers can share it without
 * importing one another, and so the whole surface the panel touches is one file
 * long — which is the only real check on a screen like this quietly growing a
 * dependency on everything.
 */

import type { RunRecord } from '../core/history';
import type { RuleLine } from '../core/rule-stats';
import type { VaultSummary } from '../core/vault-stats';
import type { BackupEstimate } from '../ops/estimate';
import type { GeodeSettings } from '../settings';
import type { Result } from '../types';
import { ICONS } from './panel-dom';
import type { ProgressSnapshot } from './progress';

/** What the plugin has to expose for the panel to work. */
export interface ProgressHost {
  /** Live settings. The Settings tab writes through this and then saves. */
  readonly settings: GeodeSettings;
  saveSettings(): Promise<void>;

  isConnected(): boolean;
  /** True once both halves of the OAuth client are filled in. */
  hasCredentials(): boolean;
  isBusy(): boolean;
  /** True when encryption is on and the key has not been derived yet. */
  isEncryptionLocked(): boolean;

  vaultName(): string;
  /** The Drive folder the backup lives in. */
  backupFolderName(): string;
  trackedFileCount(): number;

  /** Cheap: the vault against the index, without opening a file. */
  vaultSummary(): VaultSummary;
  /** The finished runs, newest first. */
  runHistory(): readonly RunRecord[];
  /** The exclusion rules as written, with what each one catches. */
  exclusionRules(): Promise<readonly RuleLine[]>;
  addExclusionRule(pattern: string): Promise<void>;
  setExclusionRuleEnabled(position: number, enabled: boolean): Promise<void>;

  pushNow(): Promise<void>;
  pullNow(): Promise<void>;
  /** A dry run: what a push would send, and how full Drive is. */
  estimateBackup(): Promise<Result<BackupEstimate>>;
  connectAccount(): Promise<void>;
  /** Opens the tree of everything the exclusion rules keep out. */
  showExcluded(): void;
}

/** The tabs, in the order they are drawn. */
export type TabId = 'status' | 'diff' | 'history' | 'stats' | 'excluded' | 'issues' | 'settings';

/** One tab's identity: what it is called, and what it looks like. */
export interface TabDef {
  readonly id: TabId;
  readonly label: string;
  readonly icon: readonly string[];
}

/**
 * The tab strip.
 *
 * Icons only, with the name in a tooltip, because seven labels do not fit in a
 * sidebar narrow enough to keep a note open next to it — which is the width this
 * panel is meant to be lived in at.
 */
export const TABS: readonly TabDef[] = [
  { id: 'status', label: 'Status', icon: ICONS.status },
  { id: 'diff', label: 'Changes', icon: ICONS.diff },
  { id: 'history', label: 'History', icon: ICONS.history },
  { id: 'stats', label: 'Stats', icon: ICONS.stats },
  { id: 'excluded', label: 'Excluded', icon: ICONS.excluded },
  { id: 'issues', label: 'Issues', icon: ICONS.issues },
  { id: 'settings', label: 'Settings', icon: ICONS.settings },
];

/**
 * The dry run, and where it has got to.
 *
 * Kept as a state rather than a value because it is the one thing on the panel
 * that costs real time — a walk of the vault and a Drive listing — and a screen
 * that cannot say "asking" for that is a screen that looks broken while it waits.
 */
export type EstimateState =
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: BackupEstimate; readonly at: number }
  | { readonly kind: 'error'; readonly message: string };

/** Everything a tab renderer is given: the state to draw, and the ways to act. */
export interface PanelContext {
  readonly host: ProgressHost;
  readonly progress: ProgressSnapshot;
  /** Recomputed on every repaint, because it is cheap and always current. */
  readonly vault: VaultSummary;
  /** One clock reading per repaint, so every relative time on screen agrees. */
  readonly now: number;
  readonly estimate: EstimateState;
  /** Null until the Excluded tab has loaded them. */
  readonly rules: readonly RuleLine[] | null;
  /**
   * True once Cancel has been pressed and before the run has stopped.
   *
   * Held by the view rather than by the button, because the Status tab is
   * rebuilt on every progress frame and a button that carries its own state
   * would spring back to "Cancel" a tenth of a second after being pressed.
   */
  readonly cancelling: boolean;

  /** Switches tab and repaints. */
  go(tab: TabId): void;
  /** Redraws the body from current state. */
  refresh(): void;
  /** Starts a push or a pull, greying the buttons at once. */
  start(kind: 'push' | 'pull'): void;
  cancel(): void;
  /** Runs the dry run, repainting when it lands. */
  check(): void;
  /** Applies a settings change, saves it, and repaints. */
  update(change: (settings: GeodeSettings) => void): void;
  toggleRule(rule: RuleLine, enabled: boolean): void;
  addRule(pattern: string): void;
}
