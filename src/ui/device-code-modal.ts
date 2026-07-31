import { Modal, Notice, Setting } from 'obsidian';

import type { DeviceCodePrompt, DeviceFlowUi } from '../drive/device-flow';

/**
 * Shows the device code while the flow polls Google in the background.
 *
 * Closing the dialog is the only way to cancel, so `isCancelled` is what the
 * poller checks between attempts.
 */
export class DeviceCodeModal extends Modal implements DeviceFlowUi {
  private cancelled = false;
  private opened = false;

  present(prompt: DeviceCodePrompt): void {
    this.cancelled = false;
    this.opened = true;

    this.titleEl.setText('Connect Google account');
    const body = this.contentEl;
    body.empty();

    body.createEl('p', {
      text: '1. Open this page on any device you can type on:',
    });
    const link = body.createEl('p');
    link.createEl('a', {
      text: prompt.verificationUrl,
      href: prompt.verificationUrl,
    });

    body.createEl('p', { text: '2. Enter this code:' });
    const code = body.createEl('p', { text: prompt.userCode });
    code.style.fontSize = '2em';
    code.style.fontWeight = 'bold';
    code.style.letterSpacing = '0.15em';
    code.style.userSelect = 'text';

    body.createEl('p', {
      text: `The code expires in about ${String(Math.round(prompt.expiresInSeconds / 60))} minutes. This window closes by itself once you approve.`,
    });

    new Setting(body)
      .addButton((button) =>
        button
          .setButtonText('Copy code')
          .setCta()
          .onClick(() => {
            void navigator.clipboard.writeText(prompt.userCode).then(
              () => new Notice('Code copied.'),
              () => new Notice('Could not copy. Type the code by hand.'),
            );
          }),
      )
      .addButton((button) =>
        button.setButtonText('Cancel').onClick(() => {
          this.cancelled = true;
          this.close();
        }),
      );

    this.open();
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  dismiss(): void {
    if (this.opened) this.close();
  }

  /** Treats a close by any means — Escape, the X, the backdrop — as a cancel. */
  override onClose(): void {
    this.cancelled = true;
    this.opened = false;
    this.contentEl.empty();
  }
}
