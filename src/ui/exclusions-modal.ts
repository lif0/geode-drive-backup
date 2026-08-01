import { Modal } from 'obsidian';
import type { App } from 'obsidian';

import { formatBytes } from '../core/bytes';
import type { TreeNode } from '../core/path-tree';
import { buildPathTree } from '../core/path-tree';
import type { ExclusionPreview } from '../ops/estimate';

/**
 * Everything the exclusion rules keep out of the backup, as a tree.
 *
 * A flat list of a few thousand paths is not something anyone reads, and an
 * exclusion that is never read is an exclusion that quietly takes a folder of
 * notes with it. Collapsed folders carrying their own counts and weights turn
 * the question into one that can be answered from the top level: three folders
 * of build output is fine, a folder called Journal is not.
 *
 * A modal rather than a panel section, because the sidebar is too narrow for a
 * tree and this is something you look at once and close.
 */

/** Folders start closed. Two and a half thousand rows would not open at all. */
const INDENT_PX = 16;

export class ExclusionsModal extends Modal {
  constructor(
    app: App,
    private readonly load: () => Promise<ExclusionPreview>,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText('Excluded from the backup');
    contentEl.empty();

    const status = contentEl.createEl('p');
    status.setText('Checking…');

    void this.load().then(
      (preview) => {
        this.renderPreview(status, preview);
      },
      (cause: unknown) => {
        status.setText(`Could not check: ${String(cause)}`);
      },
    );
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private renderPreview(status: HTMLElement, preview: ExclusionPreview): void {
    const { contentEl } = this;

    if (preview.excluded.length === 0) {
      status.setText(`Nothing is excluded. All ${String(preview.total)} files would be backed up.`);
      return;
    }

    status.setText(
      `${String(preview.excluded.length)} of ${String(preview.total)} files ` +
        `· ${formatBytes(preview.bytes)} kept out of the backup.`,
    );

    const hint = contentEl.createEl('p');
    hint.setText(
      'These are never uploaded and never even opened. Copies already on Drive are left alone. ' +
        'Click a folder to open it.',
    );
    hint.style.fontSize = 'var(--font-ui-smaller)';
    hint.style.opacity = '0.75';

    const box = contentEl.createDiv();
    box.style.maxHeight = '50vh';
    box.style.overflow = 'auto';
    box.style.marginTop = '8px';
    box.style.borderTop = '1px solid var(--background-modifier-border)';
    box.style.paddingTop = '8px';

    this.renderNodes(box, buildPathTree([...preview.excluded]), 0);
  }

  /**
   * Draws one level.
   *
   * Children are built the first time a folder is opened and kept afterwards.
   * Rendering the whole tree up front would put thousands of elements on screen
   * to show what a dozen collapsed rows already say.
   */
  private renderNodes(parent: HTMLElement, nodes: readonly TreeNode[], depth: number): void {
    for (const node of nodes) {
      const isFolder = node.children.length > 0;

      const row = parent.createDiv();
      row.style.display = 'flex';
      row.style.alignItems = 'baseline';
      row.style.gap = '6px';
      row.style.padding = '2px 0';
      row.style.paddingLeft = `${String(depth * INDENT_PX)}px`;
      row.style.fontSize = 'var(--font-ui-smaller)';

      const marker = row.createSpan();
      marker.setText(isFolder ? '▸' : '·');
      marker.style.opacity = '0.6';
      marker.style.width = '1em';
      marker.style.flex = '0 0 auto';

      const name = row.createSpan();
      name.setText(node.name);
      name.style.flex = '1';
      name.style.wordBreak = 'break-all';
      if (isFolder) name.style.fontWeight = 'var(--font-semibold)';

      const size = row.createSpan();
      size.setText(
        isFolder
          ? `${String(node.files)} files · ${formatBytes(node.bytes)}`
          : formatBytes(node.bytes),
      );
      size.style.opacity = '0.6';
      size.style.flex = '0 0 auto';

      if (!isFolder) continue;

      const children = parent.createDiv();
      children.style.display = 'none';
      let built = false;

      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const open = children.style.display !== 'none';
        if (!open && !built) {
          this.renderNodes(children, node.children, depth + 1);
          built = true;
        }
        children.style.display = open ? 'none' : '';
        marker.setText(open ? '▸' : '▾');
      });
    }
  }
}
