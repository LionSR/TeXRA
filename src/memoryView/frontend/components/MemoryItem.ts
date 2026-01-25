// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';
import {
  formatBytes,
  formatLineCount,
  formatUpdatedDate,
} from '@shared/utils/string';

// Local imports - memory view events
import { MemoryViewEvents } from '../events';

// Local imports - shared schemas
import type { MemoryViewItem } from '@shared/schemas';

@customElement('memory-item')
export class MemoryItem extends LitElement {
  static styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .memory-path {
        font-family: var(--vscode-editor-font-family), monospace;
        font-size: var(--font-size);
        font-weight: 500;
        color: var(--vscode-textLink-foreground);
        word-break: break-all;
      }

      .memory-meta {
        margin-top: var(--spacing-small);
      }

      .memory-preview {
        font-family: var(--vscode-editor-font-family), monospace;
        font-size: var(--font-size-sm);
        line-height: 1.4;
        white-space: pre-wrap;
        word-wrap: break-word;
        background-color: var(--vscode-editor-inactiveSelectionBackground);
        padding: var(--spacing-medium);
        border-radius: var(--border-radius);
        margin: 0;
        max-height: 200px;
        overflow-y: auto;
      }
    `,
  ];

  @property({ attribute: false }) item?: MemoryViewItem;

  private handleOpen = (): void => {
    if (!this.item) return;
    this.dispatchEvent(
      MemoryViewEvents.openItem({ storagePath: this.item.storagePath }),
    );
  };

  private handleDelete = (): void => {
    if (!this.item) return;
    this.dispatchEvent(
      MemoryViewEvents.deleteItem({
        storagePath: this.item.storagePath,
        displayPath: this.item.displayPath,
      }),
    );
  };

  private renderMeta(item: MemoryViewItem): string {
    const size = formatBytes(item.size ?? 0);
    const lines = formatLineCount(item.lineCount ?? 0);
    const updated = formatUpdatedDate(item.mtime);
    return [size, lines, updated].filter(Boolean).join(' · ');
  }

  render(): TemplateResult {
    if (!this.item) {
      return html``;
    }

    const previewText = this.item.preview?.trim()
      ? this.item.preview
      : 'This note is empty.';

    return html`
      <div class="list-item memory-item">
        <div class="list-item-header">
          <div class="memory-path">${this.item.displayPath}</div>
          <vscode-toolbar-container>
            <vscode-toolbar-button
              class="open-memory-btn"
              icon="go-to-file"
              label="Open"
              title="Open in editor"
              @click=${this.handleOpen}
            ></vscode-toolbar-button>
            <vscode-toolbar-button
              class="delete-memory-btn"
              icon="trash"
              label="Delete"
              title="Delete this memory"
              @click=${this.handleDelete}
            ></vscode-toolbar-button>
          </vscode-toolbar-container>
        </div>
        <div class="text-secondary memory-meta">
          ${this.renderMeta(this.item)}
        </div>
        <vscode-collapsible class="collapsible" heading="Contents">
          <pre class="memory-preview">${previewText}</pre>
        </vscode-collapsible>
      </div>
    `;
  }
}
