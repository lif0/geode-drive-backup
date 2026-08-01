import { Notice, Plugin, normalizePath } from 'obsidian';

import type { BackupState } from './core/backup-state';
import { rollUpFolders } from './core/backup-state';
import { hashBytes, toArrayBuffer } from './core/bytes';
import type { IgnoreRules } from './core/ignore';
import { NO_IGNORE_RULES, isIgnored } from './core/ignore';
import { KeyCache } from './core/kdf';
import type { AuthProvider, OAuthClient, RefreshTokenStore } from './drive/auth-provider';
import { DriveClient } from './drive/client';
import { DeviceFlowAuthProvider } from './drive/device-flow';
import { PkceAuthProvider } from './drive/pkce-flow';
import type { BackupEstimate, ExclusionPreview } from './ops/estimate';
import { estimateBackup, previewExclusions } from './ops/estimate';
import { IndexStore } from './ops/index-store';
import { runPull } from './ops/pull';
import type { PushDeps } from './ops/push';
import { cacheableMtime, loadIgnoreRules, runPush } from './ops/push';
import type { AuthFlowKind, GeodeSettings, StoredIndexEntry } from './settings';
import { defaultSettings, migrateSettings } from './settings';
import type { CancellationToken, CryptoProvider, OperationSummary, Result, VaultIo } from './types';
import { err, ioError, vaultPath } from './types';
import { DeviceCodeModal } from './ui/device-code-modal';
import { ExclusionsModal } from './ui/exclusions-modal';
import { FileExplorerBadges } from './ui/file-badges';
import { PassphraseModal, PkceCodeModal } from './ui/passphrase-modal';
import { ProgressHub, statusBarText } from './ui/progress';
import type { SettingsHost } from './ui/settings-tab';
import { GeodeSettingTab } from './ui/settings-tab';
import { GEODE_VIEW_TYPE, GeodeProgressView } from './ui/progress-view';

/** How long a burst of settings saves has to stop before the dots are redrawn. */
const BADGE_RELOAD_DELAY_MS = 500;

/**
 * How long editing has to stop before an edited file is checked against the index.
 *
 * Longer than the two seconds a timestamp needs to settle, so the check reads a
 * file whose mtime can be trusted afterwards. See `cacheableMtime`.
 */
const BADGE_VERIFY_DELAY_MS = 2500;

/**
 * The largest file re-read to answer a dot.
 *
 * The check is worth a note, or a small attachment. It is not worth hashing a
 * video every time something touches it, and a file that big is one a push can
 * take its time over.
 */
const BADGE_VERIFY_MAX_BYTES = 8 * 1024 * 1024;

/** Geode: back the vault up to Google Drive, and get it back on a new device. */
export default class GeodePlugin extends Plugin implements SettingsHost {
  override settings: GeodeSettings = defaultSettings();

  private readonly keys = new KeyCache();
  private readonly crypto: CryptoProvider = crypto;
  private index = new IndexStore({}, () => Promise.resolve());
  private auth: AuthProvider | null = null;
  private authKind: AuthFlowKind | null = null;
  private busy = false;
  private cancelRequested = false;

  /**
   * One hub for the whole plugin lifetime, not one per run.
   *
   * The panel and the status bar subscribe to it at startup and stay
   * subscribed, so closing either of them — or opening the panel halfway
   * through a push — loses nothing.
   */
  private readonly progress = new ProgressHub(() => {
    this.requestCancel();
  });

  /** Read by the ops layer between files. Never interrupts a file mid-write. */
  private readonly cancellation: CancellationToken = {
    isCancelled: () => this.cancelRequested,
  };

  /**
   * The exclusion rules, kept warm for the file explorer dots.
   *
   * Those are redrawn on every explorer mutation, and reading `.gitignore` off
   * disk that often would be absurd. Reloaded when the settings change and when
   * a run ends, which is when they can actually differ.
   */
  private ignoreRules: IgnoreRules = NO_IGNORE_RULES;
  private badges: FileExplorerBadges | null = null;
  private badgeReloadTimer: number | null = null;

  /** Edited files waiting to be compared against the index. See `verifyPending`. */
  private readonly pendingVerify = new Set<string>();
  private verifyTimer: number | null = null;

  override async onload(): Promise<void> {
    this.settings = migrateSettings(await this.loadData());
    this.index = new IndexStore(this.settings.index, (stored) => this.persistIndex(stored));

    this.addSettingTab(new GeodeSettingTab(this.app, this, this));

    this.registerView(GEODE_VIEW_TYPE, (leaf) => new GeodeProgressView(leaf, this.progress, this));
    this.mountStatusBar();

    this.addCommand({
      id: 'show-progress',
      name: 'Show progress panel',
      callback: () => {
        void this.openProgressPanel();
      },
    });

    this.addCommand({
      id: 'push',
      name: 'Push changes to Drive',
      callback: () => void this.push(),
    });
    this.addCommand({
      id: 'pull',
      name: 'Pull vault from Drive',
      callback: () => void this.pull(),
    });
    this.addCommand({
      id: 'unlock',
      name: 'Unlock encryption',
      callback: () => void this.unlock(),
    });
    this.addCommand({
      id: 'connect',
      name: 'Connect Google account',
      callback: () => void this.connectAccount(),
    });
    this.addCommand({
      id: 'status',
      name: 'Show backup status',
      callback: () => {
        this.showStatus();
      },
    });
    this.addCommand({
      id: 'cancel',
      name: 'Cancel current operation',
      callback: () => {
        this.requestCancel();
      },
    });

    // Opens the panel rather than pushing outright. A backup is not something to
    // start by brushing an icon: the panel says what is about to go, how much of
    // it there is and whether Drive has room, and only then offers the button.
    // The command palette and the settings tab still push directly.
    this.addRibbonIcon('upload-cloud', 'GeodeDrive', () => {
      void this.openProgressPanel();
    });

    this.app.workspace.onLayoutReady(() => {
      void this.startBadges();
    });

    // A file that was just edited is a file that is no longer in the backup, and
    // the dot should say so without waiting for a push. Registered one by one
    // because each vault event carries a different callback signature.
    const repaint = (): void => {
      this.badges?.schedule();
    };
    this.registerEvent(this.app.vault.on('create', repaint));
    this.registerEvent(this.app.vault.on('delete', repaint));
    this.registerEvent(this.app.vault.on('rename', repaint));
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        repaint();
        // An edit turns the dot orange at once, on the timestamp alone. Undoing
        // that edit does not turn it back, because the timestamp moved again —
        // so the file is queued to be looked at properly once typing stops.
        this.scheduleVerify(file.path);
      }),
    );
    this.registerEvent(this.app.workspace.on('layout-change', repaint));
  }

  /** Drops the derived key. Obsidian calls this on disable, reload and quit. */
  override onunload(): void {
    this.keys.clear();
    if (this.badgeReloadTimer !== null) window.clearTimeout(this.badgeReloadTimer);
    this.badgeReloadTimer = null;
    if (this.verifyTimer !== null) window.clearTimeout(this.verifyTimer);
    this.verifyTimer = null;
    this.pendingVerify.clear();
    this.badges?.stop();
    this.badges = null;
  }

  /* ----------------------------- file badges ------------------------------ */

  /** Loads the exclusion rules and turns the explorer dots on, if they are wanted. */
  private async startBadges(): Promise<void> {
    this.ignoreRules = await loadIgnoreRules({
      vault: this.createVaultIo(),
      settings: this.settings,
    });

    if (!this.settings.showFileBadges) {
      this.badges?.stop();
      this.badges = null;
      return;
    }

    this.badges ??= new FileExplorerBadges(this.app.workspace, () => this.backupStates());
    this.badges.start();
  }

  /**
   * What the file explorer should say about each path.
   *
   * "Backed up" means the index has an entry whose size and timestamp still
   * match the file — the same shortcut a push takes to decide it need not read
   * the file again. A file whose hash was recorded as uncacheable shows as
   * pending, which is accurate rather than pessimistic: the next push really
   * will read it again.
   *
   * Never opens a file. This runs on every explorer repaint.
   */
  private backupStates(): Map<string, BackupState> {
    const files = new Map<string, BackupState>();

    for (const file of this.app.vault.getFiles()) {
      const path = vaultPath(file.path);

      if (isIgnored(this.ignoreRules, path)) {
        files.set(file.path, 'excluded');
        continue;
      }

      const entry = this.index.get(path);
      const current = entry?.mtime === file.stat.mtime && entry.size === file.stat.size;
      files.set(file.path, current ? 'backed-up' : 'pending');
    }

    return rollUpFolders(files);
  }

  /** Queues an edited file, and rearms the timer. Bursts of edits cost one pass. */
  private scheduleVerify(path?: string): void {
    if (!this.settings.showFileBadges) return;
    if (path !== undefined) this.pendingVerify.add(path);
    if (this.pendingVerify.size === 0) return;

    if (this.verifyTimer !== null) window.clearTimeout(this.verifyTimer);
    this.verifyTimer = window.setTimeout(() => {
      this.verifyTimer = null;
      void this.verifyPending();
    }, BADGE_VERIFY_DELAY_MS);
  }

  /**
   * Decides, for files that were edited, whether they still match the backup.
   *
   * `backupStates` answers on the timestamp alone because it runs on every
   * repaint. That is right for the common case and wrong for one: a file edited
   * and then put back the way it was has a new timestamp and the old contents,
   * and no amount of looking at stats will ever say so. Hashing it does, and
   * hashing one file after typing stops is affordable where hashing the vault on
   * every repaint is not.
   *
   * A file whose length changed is answered without being opened: a backup that
   * matched byte for byte cannot have gained or lost bytes and still match.
   *
   * Writes the fresh stat into the index when the hash agrees, so the next push
   * skips reading the file as well — the dot and the push take the same shortcut
   * and now agree about it.
   */
  private async verifyPending(): Promise<void> {
    const paths = [...this.pendingVerify];
    this.pendingVerify.clear();

    // A run reads and hashes these files anyway, and records the result. Doing
    // it here as well would race it for the index and win nothing.
    if (this.busy) return;

    const io = this.createVaultIo();
    let repaired = false;

    for (const raw of paths) {
      const file = this.app.vault.getFileByPath(raw);
      if (file === null) continue;

      const path = vaultPath(raw);
      const entry = this.index.get(path);
      if (entry === undefined) continue;
      if (entry.mtime === file.stat.mtime && entry.size === file.stat.size) continue;
      if (entry.size !== file.stat.size) continue;
      if (file.stat.size > BADGE_VERIFY_MAX_BYTES) continue;
      if (isIgnored(this.ignoreRules, path)) continue;

      // The file is still being written to, by this or by another program.
      // Re-queued rather than trusted: a hash filed under a timestamp that has
      // not settled is the one thing that could hide a real edit.
      const mtime = cacheableMtime(file.stat.mtime, Date.now());
      if (mtime < 0) {
        this.pendingVerify.add(raw);
        continue;
      }

      try {
        const bytes = await io.readBinary(path);
        if ((await hashBytes(this.crypto, bytes)) !== entry.sha256) continue;
      } catch {
        // Unreadable right now. The dot stays orange, which is the safe answer.
        continue;
      }

      this.index.set(path, { ...entry, mtime, size: file.stat.size });
      repaired = true;
    }

    if (repaired) {
      await this.index.save();
      this.badges?.schedule();
    }
    this.scheduleVerify();
  }

  /* -------------------------- progress surfaces --------------------------- */

  /**
   * The status bar line: a place to see a run that cannot be closed by accident.
   *
   * This is the fix for the whole class of problem. A Notice is dismissed by a
   * click, and the click is usually meant for something behind it; the run then
   * continued with no counter and no Cancel button. A status bar item has no
   * dismiss gesture at all.
   *
   * Obsidian gives mobile no status bar, so the panel and the ribbon carry it
   * there instead.
   */
  private mountStatusBar(): void {
    const item = this.addStatusBarItem();
    item.addClass('mod-clickable');
    item.setAttribute('aria-label', 'GeodeDrive: open the progress panel');
    item.addEventListener('click', () => {
      void this.openProgressPanel();
    });

    this.register(
      this.progress.subscribe((snapshot) => {
        item.setText(statusBarText(snapshot));
      }),
    );
  }

  /** Opens the panel in the right sidebar, or reveals it if it is already there. */
  private async openProgressPanel(): Promise<void> {
    const { workspace } = this.app;

    const open = workspace.getLeavesOfType(GEODE_VIEW_TYPE);
    const existing = open[0];
    if (existing !== undefined) {
      await workspace.revealLeaf(existing);
      return;
    }

    const leaf = workspace.getRightLeaf(false);
    if (leaf === null) return;

    await leaf.setViewState({ type: GEODE_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }

  /* ------------------------------ operations ------------------------------ */

  private async push(): Promise<void> {
    await this.run(() => runPush(this.operationDeps()));
  }

  private async pull(): Promise<void> {
    // PullDeps and PushDeps are structurally identical, so one wiring serves both.
    await this.run(() => runPull(this.operationDeps()));
  }

  /**
   * One operation at a time. Two concurrent pushes would race on the index and
   * on the Drive folder, and the user has no way to see that happening.
   */
  private async run(operation: () => Promise<Result<OperationSummary>>): Promise<void> {
    if (this.busy) {
      new Notice('GeodeDrive is already working. Wait for it to finish.');
      return;
    }

    this.busy = true;
    this.cancelRequested = false;
    try {
      const result = await operation();
      if (result.ok) this.progress.done(result.value);
      else this.progress.fail(result.error);
    } finally {
      this.busy = false;
      this.badges?.schedule();
    }
  }

  private operationDeps(): PushDeps {
    return {
      vault: this.createVaultIo(),
      drive: new DriveClient(this.authProvider(), this.crypto, this.cancellation),
      crypto: this.crypto,
      index: this.index,
      keys: this.keys,
      progress: this.progress,
      settings: this.settings,
      cancellation: this.cancellation,
      requestPassphrase: (isNewVault) =>
        new PassphraseModal(this.app, {
          title: isNewVault ? 'Set an encryption passphrase' : 'Unlock encryption',
          description: isNewVault
            ? 'This vault has no encrypted backup yet. Choose a passphrase; it never leaves this device.'
            : 'Enter the passphrase used for this vault.',
          confirm: isNewVault,
        }).ask(),
      rememberFolderId: async (id) => {
        this.settings.folderId = id;
        await this.saveSettings();
      },
    };
  }

  private async unlock(): Promise<void> {
    if (!this.settings.encryptionEnabled) {
      new Notice('GeodeDrive: encryption is switched off in settings.');
      return;
    }
    // Unlocking needs the vault salt, which lives in __keycheck on Drive. A push
    // fetches it, validates the passphrase and caches the key for the session.
    await this.push();
  }

  /** Asks the running operation to stop after the file it is on. */
  private requestCancel(): void {
    if (!this.busy) {
      new Notice('GeodeDrive: nothing is running.');
      return;
    }
    this.cancelRequested = true;
    new Notice('GeodeDrive: stopping after the current file…', 4000);
  }

  private showStatus(): void {
    const lines = [
      this.isConnected() ? 'Connected to Google Drive.' : 'Not connected to Google Drive.',
      `Folder: ${this.settings.folderName}`,
      `Tracked files: ${String(this.index.size())}`,
      this.settings.encryptionEnabled
        ? `Encryption on (${this.keys.isUnlocked() ? 'unlocked' : 'locked'}), ${String(this.settings.encryptedPrefixes.length)} path rules`
        : 'Encryption off',
      this.settings.mirrorDeletions
        ? 'Deletions are mirrored to Drive.'
        : 'Deletions stay on Drive.',
    ];
    new Notice(`GeodeDrive\n${lines.join('\n')}`, 10_000);
  }

  /* -------------------------------- wiring -------------------------------- */

  /**
   * Vault access for the ops layer.
   *
   * Enumerates through `getFiles()`, which covers the notes and attachments
   * Obsidian tracks and deliberately excludes `.obsidian/` — that folder holds
   * this plugin's data.json, and with it the Google refresh token.
   */
  private createVaultIo(): VaultIo {
    const adapter = this.app.vault.adapter;

    return {
      listFiles: () =>
        Promise.resolve(
          this.app.vault.getFiles().map((file) => ({
            path: vaultPath(file.path),
            mtime: file.stat.mtime,
            size: file.stat.size,
          })),
        ),
      readBinary: async (path) => new Uint8Array(await adapter.readBinary(normalizePath(path))),
      writeBinary: (path, data) => adapter.writeBinary(normalizePath(path), toArrayBuffer(data)),
      exists: (path) => adapter.exists(normalizePath(path)),
      ensureParentFolder: async (path) => {
        const segments = path.split('/').slice(0, -1);
        for (let depth = 1; depth <= segments.length; depth += 1) {
          const folder = normalizePath(segments.slice(0, depth).join('/'));
          if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
        }
      },
    };
  }

  /** Builds the auth provider, rebuilding it if the user switched flows. */
  private authProvider(): AuthProvider {
    if (this.auth !== null && this.authKind === this.settings.authFlow) return this.auth;

    const readClient = (): OAuthClient => ({
      clientId: this.settings.clientId,
      clientSecret: this.settings.clientSecret,
    });
    const tokens: RefreshTokenStore = {
      read: () => this.settings.refreshToken,
      write: async (token) => {
        this.settings.refreshToken = token;
        await this.saveSettings();
      },
    };

    this.auth =
      this.settings.authFlow === 'pkce'
        ? new PkceAuthProvider(readClient, tokens, this.crypto, new PkceCodeModal(this.app))
        : new DeviceFlowAuthProvider(readClient, tokens, new DeviceCodeModal(this.app));
    this.authKind = this.settings.authFlow;
    return this.auth;
  }

  private async persistIndex(stored: Record<string, StoredIndexEntry>): Promise<void> {
    this.settings.index = stored;
    // Straight to disk, deliberately not through saveSettings. This runs every
    // 25 files, and saveSettings reloads .gitignore and rescans the vault to
    // repaint the explorer dots — thirty times over a push, for rules that
    // cannot have changed since it started.
    await this.saveData(this.settings);
  }

  /* ---------------------------- SettingsHost ------------------------------ */

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Debounced: this fires on every keystroke in a settings text area, and the
    // reload behind it reads a file and walks the whole vault.
    this.scheduleBadgeReload();
  }

  async connectAccount(): Promise<void> {
    const result = await this.authProvider().connect();
    new Notice(
      result.ok ? 'GeodeDrive: connected to Google Drive.' : `GeodeDrive: ${result.error.message}`,
    );
  }

  async disconnectAccount(): Promise<void> {
    await this.authProvider().disconnect();
    new Notice('GeodeDrive: forgot the stored Google token.');
  }

  isConnected(): boolean {
    return this.settings.refreshToken !== null;
  }

  async pushNow(): Promise<void> {
    await this.push();
  }

  async pullNow(): Promise<void> {
    await this.pull();
  }

  isBusy(): boolean {
    return this.busy;
  }

  isUnlocked(): boolean {
    return this.keys.isUnlocked();
  }

  lockEncryption(): void {
    this.keys.clear();
  }

  trackedFileCount(): number {
    return this.index.size();
  }

  backupFolderName(): string {
    return this.settings.folderName;
  }

  /**
   * A dry run for the panel: what a push would send, and how full Drive is.
   *
   * Holds the same busy flag a real run does, because it walks the vault and
   * talks to Drive, and two of those at once would fight over both.
   * `progress.idle()` afterwards because an estimate has no summary to show —
   * without it the panel would sit there claiming to be reading the vault.
   */
  async estimateBackup(): Promise<Result<BackupEstimate>> {
    if (this.busy) return err(ioError('GeodeDrive is already working. Wait for it to finish.'));

    this.busy = true;
    this.cancelRequested = false;
    try {
      return await estimateBackup(this.operationDeps());
    } finally {
      this.busy = false;
      this.progress.idle();
    }
  }

  /** Runs the exclusion rules over the vault without touching Drive. */
  async previewExclusions(): Promise<ExclusionPreview> {
    return previewExclusions({ vault: this.createVaultIo(), settings: this.settings });
  }

  /** Opens the tree of everything the rules keep out. */
  showExcluded(): void {
    new ExclusionsModal(this.app, () => this.previewExclusions()).open();
  }

  /**
   * Re-reads the exclusion rules and repaints the dots, once things settle.
   *
   * The rules live in a file and in settings, and neither announces itself, so
   * a save is the only signal. Debounced because saves come in bursts, and
   * skipped while a run is going: the rules are fixed for the length of a run,
   * and the run has better uses for the main thread.
   */
  private scheduleBadgeReload(): void {
    if (this.badgeReloadTimer !== null) window.clearTimeout(this.badgeReloadTimer);

    this.badgeReloadTimer = window.setTimeout(() => {
      this.badgeReloadTimer = null;
      if (this.busy) return;
      void this.startBadges();
    }, BADGE_RELOAD_DELAY_MS);
  }
}
