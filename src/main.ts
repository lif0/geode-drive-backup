import { Notice, Plugin } from 'obsidian';

/**
 * Geode plugin entry point: lifecycle, commands and wiring only.
 * Stage 5 fills in the real commands. No business logic lives here.
 */
export default class GeodePlugin extends Plugin {
  override onload(): void {
    this.addCommand({
      id: 'show-backup-status',
      name: 'Show backup status',
      callback: () => {
        new Notice('Geode: not configured yet.');
      },
    });
  }
}
