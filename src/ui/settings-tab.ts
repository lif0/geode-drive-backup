import { PluginSettingTab, Setting } from 'obsidian';
import type { App, Plugin } from 'obsidian';

import { formatBytes } from '../core/bytes';
import type { ExclusionPreview } from '../ops/estimate';
import type { GeodeSettings } from '../settings';
import { formatPrefixList, parsePrefixList } from '../core/selector';
import { BADGE_LEGEND } from './file-badges';

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
  /** True while a push or pull is running, so the buttons can disable. */
  isBusy(): boolean;
  pushNow(): Promise<void>;
  pullNow(): Promise<void>;
  lockEncryption(): void;
  /** How many files the local index is tracking. */
  trackedFileCount(): number;
  /** Applies the exclusion rules without uploading anything. */
  previewExclusions(): Promise<ExclusionPreview>;
}

const PREFIX_HELP =
  'One path prefix per line. "Journal" matches the Journal folder and everything ' +
  'in it, but not Journalism.md. "Journal*" matches any path starting with those ' +
  'characters, including Journalism.md. Lines starting with # are ignored. ' +
  'Matching is case-sensitive.';

const IGNORE_HELP =
  'One rule per line, .gitignore syntax: "bin/" for a folder, "*.mp4" for an ' +
  'extension, "/Drafts" to pin it to the vault root, "!keep.mp4" to bring one ' +
  'file back. A rule without a slash matches at any depth, so "test/" also ' +
  "excludes Notes/test. These lines are applied after the vault's .gitignore.";

/** Turns a dry run into the sentence shown under the Preview button. */
function describeExclusions(preview: ExclusionPreview): string {
  if (preview.total === 0) return 'This vault has no files to check.';
  if (preview.excluded.length === 0) {
    return `Nothing is excluded — all ${String(preview.total)} files would be backed up.`;
  }

  const sample = preview.excluded.slice(0, 6).map((file) => file.path);
  const hidden = preview.excluded.length - sample.length;
  const more = hidden > 0 ? `, and ${String(hidden)} more` : '';

  return (
    `${String(preview.excluded.length)} of ${String(preview.total)} files ` +
    `· ${formatBytes(preview.bytes)} would be left out: ${sample.join(', ')}${more}`
  );
}

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

    this.renderActions(containerEl);
    this.renderAccount(containerEl);
    this.renderStorage(containerEl);
    this.renderExclusions(containerEl);
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

  private renderActions(root: HTMLElement): void {
    const ready = this.host.isConnected() && !this.host.isBusy();

    new Setting(root)
      .setName('Backup')
      .setDesc(
        this.host.isBusy()
          ? 'Working. Use "Cancel current operation" from the command palette, or the button on the progress notice.'
          : 'Push uploads what changed. Pull rebuilds this vault from Drive without overwriting anything.',
      )
      .addButton((button) => {
        button
          .setButtonText('Push now')
          .setCta()
          .setDisabled(!ready)
          .onClick(async () => {
            await this.host.pushNow();
            this.refresh();
          });
      })
      .addButton((button) => {
        button
          .setButtonText('Pull now')
          .setDisabled(!ready)
          .onClick(async () => {
            await this.host.pullNow();
            this.refresh();
          });
      });

    if (!this.host.isConnected()) {
      const hint = root.createEl('p');
      hint.setText('Connect a Google account below to enable these.');
      hint.style.opacity = '0.7';
    }
  }

  private renderAccount(root: HTMLElement): void {
    new Setting(root).setName('Google account').setHeading();

    const intro = root.createEl('p');
    intro.setText(
      'GeodeDrive uses your own Google Cloud OAuth client, so your notes never pass through anyone else. ' +
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
          .setPlaceholder('GeodeDrive')
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

  private renderExclusions(root: HTMLElement): void {
    new Setting(root).setName('What gets backed up').setHeading();

    new Setting(root)
      .setName("Respect the vault's .gitignore")
      .setDesc(
        'Reads .gitignore from the vault root and leaves out what it excludes — build output, ' +
          'binaries, anything a repository already knows is not worth keeping. Excluded files ' +
          'are never even opened. Copies already on Drive are left alone, never deleted.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.settings.useGitignore).onChange(async (value) => {
          this.settings.useGitignore = value;
          await this.host.saveSettings();
        }),
      );

    new Setting(root)
      .setName('Never upload these paths')
      .setDesc(IGNORE_HELP)
      .addTextArea((area) => {
        area.inputEl.rows = 6;
        area.inputEl.style.width = '100%';
        area
          .setPlaceholder('bin/\nlogs/\n*.mp4\n!Notes/demo.mp4')
          .setValue(this.settings.excludedPaths.join('\n'))
          .onChange(async (value) => {
            this.settings.excludedPaths = value
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0);
            await this.host.saveSettings();
          });
      });

    // An exclusion rule fails silently by design: the file is simply not there
    // the day it is needed. A dry run is the only honest way to find out that
    // "test/" also took out the folder of notes called test.
    const preview = new Setting(root)
      .setName('Check the rules')
      .setDesc('Applies the rules to this vault and lists what they leave out. Changes nothing.');

    new Setting(root)
      .setName('Mark files in the file explorer')
      .setDesc(
        'A dot on every file and folder in the sidebar: ' +
          `${BADGE_LEGEND.map((entry) => entry.label).join('; ')}. ` +
          'A folder takes the loudest state of anything inside it. Obsidian gives plugins no ' +
          'API for this, so it is drawn onto the explorer markup and could break on an update.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.settings.showFileBadges).onChange(async (value) => {
          this.settings.showFileBadges = value;
          await this.host.saveSettings();
        }),
      );

    preview.addButton((button) =>
      button.setButtonText('Preview exclusions').onClick(async () => {
        button.setDisabled(true);
        preview.setDesc('Checking…');
        try {
          preview.setDesc(describeExclusions(await this.host.previewExclusions()));
        } finally {
          button.setDisabled(false);
        }
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
