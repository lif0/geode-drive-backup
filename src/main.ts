import { Notice, Plugin, normalizePath } from 'obsidian';

import { toArrayBuffer } from './core/bytes';
import { KeyCache } from './core/kdf';
import type { AuthProvider, OAuthClient, RefreshTokenStore } from './drive/auth-provider';
import { DriveClient } from './drive/client';
import { DeviceFlowAuthProvider } from './drive/device-flow';
import { PkceAuthProvider } from './drive/pkce-flow';
import { IndexStore } from './ops/index-store';
import { runPull } from './ops/pull';
import type { PushDeps } from './ops/push';
import { runPush } from './ops/push';
import type { AuthFlowKind, GeodeSettings, StoredIndexEntry } from './settings';
import { defaultSettings, migrateSettings } from './settings';
import type { CryptoProvider, OperationSummary, Result, VaultIo } from './types';
import { vaultPath } from './types';
import { DeviceCodeModal } from './ui/device-code-modal';
import { PassphraseModal, PkceCodeModal } from './ui/passphrase-modal';
import { NoticeProgress } from './ui/progress';
import type { SettingsHost } from './ui/settings-tab';
import { GeodeSettingTab } from './ui/settings-tab';

/** Geode: back the vault up to Google Drive, and get it back on a new device. */
export default class GeodePlugin extends Plugin implements SettingsHost {
  override settings: GeodeSettings = defaultSettings();

  private readonly keys = new KeyCache();
  private readonly crypto: CryptoProvider = crypto;
  private index = new IndexStore({}, () => Promise.resolve());
  private auth: AuthProvider | null = null;
  private authKind: AuthFlowKind | null = null;
  private busy = false;

  override async onload(): Promise<void> {
    this.settings = migrateSettings(await this.loadData());
    this.index = new IndexStore(this.settings.index, (stored) => this.persistIndex(stored));

    this.addSettingTab(new GeodeSettingTab(this.app, this, this));

    this.addCommand({ id: 'push', name: 'Push changes to Drive', callback: () => void this.push() });
    this.addCommand({ id: 'pull', name: 'Pull vault from Drive', callback: () => void this.pull() });
    this.addCommand({ id: 'unlock', name: 'Unlock encryption', callback: () => void this.unlock() });
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
  }

  /** Drops the derived key. Obsidian calls this on disable, reload and quit. */
  override onunload(): void {
    this.keys.clear();
  }

  /* ------------------------------ operations ------------------------------ */

  private async push(): Promise<void> {
    await this.run((progress) => runPush(this.operationDeps(progress)));
  }

  private async pull(): Promise<void> {
    // PullDeps and PushDeps are structurally identical, so one wiring serves both.
    await this.run((progress) => runPull(this.operationDeps(progress)));
  }

  /**
   * One operation at a time. Two concurrent pushes would race on the index and
   * on the Drive folder, and the user has no way to see that happening.
   */
  private async run(
    operation: (progress: NoticeProgress) => Promise<Result<OperationSummary>>,
  ): Promise<void> {
    if (this.busy) {
      new Notice('Geode is already working. Wait for it to finish.');
      return;
    }

    this.busy = true;
    const progress = new NoticeProgress();
    try {
      const result = await operation(progress);
      if (result.ok) progress.done(result.value);
      else progress.fail(result.error);
    } finally {
      this.busy = false;
    }
  }

  private operationDeps(progress: NoticeProgress): PushDeps {
    return {
      vault: this.createVaultIo(),
      drive: new DriveClient(this.authProvider(), this.crypto),
      crypto: this.crypto,
      index: this.index,
      keys: this.keys,
      progress,
      settings: this.settings,
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
      new Notice('Geode: encryption is switched off in settings.');
      return;
    }
    // Unlocking needs the vault salt, which lives in __keycheck on Drive. A push
    // fetches it, validates the passphrase and caches the key for the session.
    await this.push();
  }

  private showStatus(): void {
    const lines = [
      this.isConnected() ? 'Connected to Google Drive.' : 'Not connected to Google Drive.',
      `Folder: ${this.settings.folderName}`,
      `Tracked files: ${String(this.index.size())}`,
      this.settings.encryptionEnabled
        ? `Encryption on (${this.keys.isUnlocked() ? 'unlocked' : 'locked'}), ${String(this.settings.encryptedPrefixes.length)} path rules`
        : 'Encryption off',
      this.settings.mirrorDeletions ? 'Deletions are mirrored to Drive.' : 'Deletions stay on Drive.',
    ];
    new Notice(`Geode\n${lines.join('\n')}`, 10_000);
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
    new Notice(result.ok ? 'Geode: connected to Google Drive.' : `Geode: ${result.error.message}`);
  }

  async disconnectAccount(): Promise<void> {
    await this.authProvider().disconnect();
    new Notice('Geode: forgot the stored Google token.');
  }

  isConnected(): boolean {
    return this.settings.refreshToken !== null;
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
}
