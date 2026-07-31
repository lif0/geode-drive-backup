import { PluginSettingTab, Setting } from 'obsidian';
import type { App, Plugin } from 'obsidian';

import { formatPrefixList, parsePrefixList } from '../core/selector';
import type { GeodeSettings } from '../settings';

/**
 * The settings tab.
 *
 * What the plugin has to expose for this screen to work. Declared here rather
 * than importing the plugin class, which would make the import graph circular.
 */
export interface SettingsHost {
  readonly settings: GeodeSettings;
  saveSettings(): Promise<void>;
  /** Runs the interactive sign-in and refreshes this tab when it finishes. */
  connectAccount(): Promise<void>;
  disconnectAccount(): Promise<void>;
  isConnected(): boolean;
  isUnlocked(): boolean;
  lockEncryption(): void;
  /** How many files the local index is tracking. */
  trackedFileCount(): number;
}

const PREFIX_HELP =
  'One path prefix per line. "Journal" matches the Journal folder and everything ' +
  'in it, but not Journalism.md. "Journal*" matches any path starting with those ' +
  'characters, including Journalism.md. Lines starting with # are ignored. ' +
  'Matching is case-sensitive.';

/** Geode's settings screen. */
export class GeodeSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly host: SettingsHost,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderAccount(containerEl);
    this.renderStorage(containerEl);
    this.renderEncryption(containerEl);
    this.renderDeletions(containerEl);
    this.renderStatus(containerEl);
  }

  /**
   * Re-renders the tab. `display()` is deprecated in Obsidian 1.13 in favour of
   * getSettingDefinitions, which does not exist at our minAppVersion of 1.4.
   */
  private refresh(): void {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
    this.display();
  }

  private get settings(): GeodeSettings {
    return this.host.settings;
  }

  private renderAccount(root: HTMLElement): void {
    new Setting(root).setName('Google account').setHeading();

    const intro = root.createEl('p');
    intro.setText(
      'Geode uses your own Google Cloud OAuth client, so your notes never pass through anyone else. ' +
        'Create one at console.cloud.google.com, enable the Drive API, and make a client of type ' +
        '"TVs and Limited Input devices".',
    );

    new Setting(root)
      .setName('Client ID')
      .setDesc('From your OAuth client. Ends in .apps.googleusercontent.com')
      .addText((text) =>
        text
          .setPlaceholder('…apps.googleusercontent.com')
          .setValue(this.settings.clientId)
          .onChange(async (value) => {
            this.settings.clientId = value.trim();
            await this.host.saveSettings();
          }),
      );

    new Setting(root)
      .setName('Client secret')
      .setDesc('Stored in this vault only, in .obsidian/plugins/geode-drive-backup/data.json')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('GOCSPX-…')
          .setValue(this.settings.clientSecret)
          .onChange(async (value) => {
            this.settings.clientSecret = value.trim();
            await this.host.saveSettings();
          });
      });

    new Setting(root)
      .setName('Sign-in method')
      .setDesc(
        'Device flow shows a code to type on another device. Use the PKCE fallback only if ' +
          'Google refuses the device flow for your client type.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('device', 'Device code (recommended)')
          .addOption('pkce', 'Redirect with PKCE (fallback)')
          .setValue(this.settings.authFlow)
          .onChange(async (value) => {
            this.settings.authFlow = value === 'pkce' ? 'pkce' : 'device';
            await this.host.saveSettings();
          }),
      );

    const connected = this.host.isConnected();
    new Setting(root)
      .setName('Connection')
      .setDesc(connected ? 'Connected to Google Drive.' : 'Not connected.')
      .addButton((button) => {
        button.setButtonText(connected ? 'Reconnect' : 'Connect').onClick(async () => {
          button.setDisabled(true);
          await this.host.connectAccount();
          this.refresh();
        });
        if (!connected) button.setCta();
      })
      .addExtraButton((button) =>
        button
          .setIcon('log-out')
          .setTooltip('Forget the stored token')
          .onClick(async () => {
            await this.host.disconnectAccount();
            this.refresh();
          }),
      );
  }

  private renderStorage(root: HTMLElement): void {
    new Setting(root).setName('Storage').setHeading();

    new Setting(root)
      .setName('Drive folder name')
      .setDesc(
        'One flat folder holds the whole backup. Changing this after a push points Geode at a ' +
          'different folder and it will upload everything again.',
      )
      .addText((text) =>
        text
          .setPlaceholder('Geode')
          .setValue(this.settings.folderName)
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (trimmed.length === 0) return;
            if (trimmed !== this.settings.folderName) {
              this.settings.folderName = trimmed;
              // The cached id belongs to the old folder.
              this.settings.folderId = null;
            }
            await this.host.saveSettings();
          }),
      );
  }

  private renderEncryption(root: HTMLElement): void {
    new Setting(root).setName('Encryption').setHeading();

    new Setting(root)
      .setName('Encrypt selected paths')
      .setDesc(
        'AES-256-GCM with a key derived from your passphrase. File names are NOT encrypted — ' +
          'anyone with access to the Drive folder can see every path in your vault.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.settings.encryptionEnabled).onChange(async (value) => {
          this.settings.encryptionEnabled = value;
          await this.host.saveSettings();
          this.refresh();
        }),
      );

    if (!this.settings.encryptionEnabled) return;

    new Setting(root)
      .setName('Encrypted paths')
      .setDesc(PREFIX_HELP)
      .addTextArea((area) => {
        area.inputEl.rows = 6;
        area.inputEl.style.width = '100%';
        area
          .setPlaceholder('Journal\nSecrets/keys\nFinance*')
          .setValue(formatPrefixList(this.settings.encryptedPrefixes))
          .onChange(async (value) => {
            this.settings.encryptedPrefixes = parsePrefixList(value);
            await this.host.saveSettings();
          });
      });

    new Setting(root)
      .setName('Ask for the passphrase')
      .setDesc(
        'Deriving the key takes about a second, so it is cached in memory after the first ' +
          'unlock. It is always cleared when Obsidian closes the plugin.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('once-per-session', 'Once per session')
          .addOption('every-operation', 'Every push and pull')
          .setValue(this.settings.passphrasePrompt)
          .onChange(async (value) => {
            this.settings.passphrasePrompt =
              value === 'every-operation' ? 'every-operation' : 'once-per-session';
            await this.host.saveSettings();
          }),
      );

    new Setting(root)
      .setName('Encryption key')
      .setDesc(this.host.isUnlocked() ? 'Unlocked for this session.' : 'Locked.')
      .addButton((button) =>
        button
          .setButtonText('Lock now')
          .setDisabled(!this.host.isUnlocked())
          .onClick(() => {
            this.host.lockEncryption();
            this.refresh();
          }),
      );
  }

  private renderDeletions(root: HTMLElement): void {
    new Setting(root).setName('Deletions').setHeading();

    new Setting(root)
      .setName('Mirror deletions to Drive')
      .setDesc(
        'Off: a file you delete locally stays on Drive, and the backup keeps it. ' +
          'On: pushing deletes it from Drive permanently, without going to the trash. ' +
          'A backup that forgets what you deleted cannot get it back for you.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.settings.mirrorDeletions).onChange(async (value) => {
          this.settings.mirrorDeletions = value;
          await this.host.saveSettings();
        }),
      );
  }

  private renderStatus(root: HTMLElement): void {
    new Setting(root).setName('Status').setHeading();

    const tracked = this.host.trackedFileCount();
    new Setting(root)
      .setName('Tracked files')
      .setDesc(
        tracked === 0
          ? 'Nothing pushed yet from this device.'
          : `${String(tracked)} files in the local index.`,
      );
  }
}
