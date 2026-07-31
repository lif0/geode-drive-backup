import { Modal, Setting } from 'obsidian';
import type { App } from 'obsidian';

import type { PkceFlowUi } from '../drive/pkce-flow';

/**
 * Asks for the encryption passphrase, and for the PKCE authorization code.
 *
 * Both are secrets the user types once and Geode never writes down: the
 * passphrase is turned into a key and forgotten, the code is exchanged for a
 * refresh token and forgotten.
 */

/** How the passphrase prompt should present itself. */
export interface PassphraseRequest {
  readonly title: string;
  readonly description: string;
  /** Asks twice and requires a match. Used when creating the vault key. */
  readonly confirm: boolean;
}

/** Modal that resolves to the typed passphrase, or null if cancelled. */
export class PassphraseModal extends Modal {
  private resolve: ((value: string | null) => void) | null = null;
  private first = '';
  private second = '';
  private submitted = false;

  constructor(
    app: App,
    private readonly request: PassphraseRequest,
  ) {
    super(app);
  }

  /** Opens the dialog and waits for an answer. */
  ask(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  override onOpen(): void {
    this.titleEl.setText(this.request.title);
    const body = this.contentEl;
    body.empty();
    body.createEl('p', { text: this.request.description });

    new Setting(body).setName('Passphrase').addText((text) => {
      text.inputEl.type = 'password';
      text.inputEl.autocapitalize = 'off';
      text.setPlaceholder('Your passphrase').onChange((value) => {
        this.first = value;
      });
      text.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter') this.submit();
      });
      window.setTimeout(() => {
        text.inputEl.focus();
      }, 0);
    });

    if (this.request.confirm) {
      new Setting(body).setName('Repeat passphrase').addText((text) => {
        text.inputEl.type = 'password';
        text.inputEl.autocapitalize = 'off';
        text.setPlaceholder('Type it again').onChange((value) => {
          this.second = value;
        });
        text.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
          if (event.key === 'Enter') this.submit();
        });
      });

      body.createEl('p', {
        text: 'There is no recovery. If you forget this passphrase, the encrypted files on Drive cannot be read by anyone, including you.',
      });
    }

    const error = body.createEl('p');
    error.style.color = 'var(--text-error)';
    error.hide();

    new Setting(body)
      .addButton((button) =>
        button
          .setButtonText(this.request.confirm ? 'Create' : 'Unlock')
          .setCta()
          .onClick(() => {
            const problem = this.validate();
            if (problem === null) {
              this.submit();
              return;
            }
            error.setText(problem);
            error.show();
          }),
      )
      .addButton((button) =>
        button.setButtonText('Cancel').onClick(() => {
          this.close();
        }),
      );
  }

  private validate(): string | null {
    if (this.first.length === 0) return 'Enter a passphrase.';
    if (this.request.confirm && this.first !== this.second) return 'The two entries do not match.';
    return null;
  }

  private submit(): void {
    if (this.validate() !== null) return;
    this.submitted = true;
    const passphrase = this.first;
    this.close();
    this.finish(passphrase);
  }

  override onClose(): void {
    this.contentEl.empty();
    // Do not leave the passphrase sitting in a field of a live object.
    this.first = '';
    this.second = '';
    if (!this.submitted) this.finish(null);
  }

  private finish(value: string | null): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(value);
  }
}

/**
 * The PKCE fallback's code-paste dialog.
 *
 * The redirect goes to a loopback URL nothing is listening on, so the browser
 * shows an error page and the code is in the address bar. Accepting the whole
 * URL saves the user from picking the code out by hand.
 */
export class PkceCodeModal extends Modal implements PkceFlowUi {
  private resolve: ((value: string | null) => void) | null = null;
  private pasted = '';
  private submitted = false;
  private authUrl = '';

  requestCode(authUrl: string): Promise<string | null> {
    this.authUrl = authUrl;
    this.submitted = false;
    return new Promise<string | null>((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  override onOpen(): void {
    this.titleEl.setText('Connect Google account');
    const body = this.contentEl;
    body.empty();

    body.createEl('p', { text: '1. Open this link and approve access:' });
    const link = body.createEl('p');
    link.createEl('a', { text: 'Authorise Geode on Google', href: this.authUrl });

    body.createEl('p', {
      text: '2. The browser will fail to load a 127.0.0.1 page. That is expected. Copy the whole address from the address bar and paste it below.',
    });

    new Setting(body).setName('Redirected URL or code').addText((text) => {
      text.setPlaceholder('http://127.0.0.1:42813/geode?code=…').onChange((value) => {
        this.pasted = value;
      });
      window.setTimeout(() => {
        text.inputEl.focus();
      }, 0);
    });

    new Setting(body)
      .addButton((button) =>
        button
          .setButtonText('Finish')
          .setCta()
          .onClick(() => {
            this.submitted = true;
            const value = this.pasted;
            this.close();
            this.finish(value);
          }),
      )
      .addButton((button) =>
        button.setButtonText('Cancel').onClick(() => {
          this.close();
        }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
    this.pasted = '';
    if (!this.submitted) this.finish(null);
  }

  private finish(value: string | null): void {
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(value);
  }
}
