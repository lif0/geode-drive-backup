import { Notice, Plugin, normalizePath } from 'obsidian';

import { toArrayBuffer } from './core/bytes';
import { isIgnored } from './core/ignore';
import { KeyCache } from './core/kdf';
import type { AuthProvider, OAuthClient, RefreshTokenStore } from './drive/auth-provider';
import { DriveClient } from './drive/client';
import { DeviceFlowAuthProvider } from './drive/device-flow';
import { PkceAuthProvider } from './drive/pkce-flow';
import { IndexStore } from './ops/index-store';
import { runPull } from './ops/pull';
import type { PushDeps } from './ops/push';
import { loadIgnoreRules, runPush } from './ops/push';
import type { AuthFlowKind, GeodeSettings, StoredIndexEntry } from './settings';
import { defaultSettings, migrateSettings } from './settings';
import type { CancellationToken, CryptoProvider, OperationSummary, Result, VaultIo } from './types';
import { vaultPath } from './types';
import { DeviceCodeModal } from './ui/device-code-modal';
import { PassphraseModal, PkceCodeModal } from './ui/passphrase-modal';
import { ProgressHub, statusBarText } from './ui/progress';
import type { ExclusionPreview, SettingsHost } from './ui/settings-tab';
import { GeodeSettingTab } from './ui/settings-tab';
import { GEODE_VIEW_TYPE, GeodeProgressView } from './ui/progress-view';

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

  override async onload(): Promise<void> {
    this.settings = migrateSettings(await this.loadData());
    this.index = new IndexStore(this.settings.index, (stored) => this.persistIndex(stored));

    this.addSettingTab(new GeodeSettingTab(this.app, this, this));

    this.registerView(GEODE_VIEW_TYPE, (leaf) => new GeodeProgressView(leaf, this.progress));
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

    this.addRibbonIcon('upload-cloud', 'GeodeDrive: push changes to Drive', () => {
      void this.push();
    });
  }

  /** Drops the derived key. Obsidian calls this on disable, reload and quit. */
  override onunload(): void {
    this.keys.clear();
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
    await this.saveSettings();
  }

  /* ---------------------------- SettingsHost ------------------------------ */

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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

  /** Runs the exclusion rules over the vault without touching Drive. */
  async previewExclusions(): Promise<ExclusionPreview> {
    const vault = this.createVaultIo();
    const ignore = await loadIgnoreRules({ vault, settings: this.settings });

    const all = await vault.listFiles();
    const excluded = all.filter((stat) => isIgnored(ignore, stat.path));

    return {
      total: all.length,
      excluded: excluded.length,
      sample: excluded.slice(0, 8).map((stat) => stat.path),
    };
  }
}
