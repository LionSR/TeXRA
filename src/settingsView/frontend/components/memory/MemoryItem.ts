/**
 * MemoryItem component - displays a single memory entry with metadata and preview.
 */

// Third-party imports
import { LitElement, html, nothing, css, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import MarkdownIt from 'markdown-it';

// Local imports - shared styles
import { designTokens, codiconStyles, commonViewStyles } from '@shared/styles';
import { markdownStyles } from '@shared/styles/markdownStyles';
import type { MemoryViewItem } from '@shared/schemas';
import {
  formatBytes,
  formatLineCount,
  formatUpdatedDate,
} from '@shared/utils/string';
import { highlightCode } from '@shared/highlighting/highlightCode';

// Local imports - memory view events
import { MemoryViewEvents } from './events';

/** Lazy-initialized lightweight markdown renderer (no LaTeX/KaTeX). */
let md: MarkdownIt | null = null;
const getMd = (): MarkdownIt => {
  if (!md) {
    md = new MarkdownIt({
      breaks: false,
      linkify: true,
      html: false,
      highlight: highlightCode,
    });
  }
  return md;
};

@customElement('memory-item')
export class MemoryItem extends LitElement {
  static override styles = [
    designTokens,
    codiconStyles,
    commonViewStyles,
    markdownStyles,
    css`
      :host {
        display: block;
      }

      .memory-path {
        font-family: var(--vscode-editor-font-family), monospace;
        font-size: var(--font-size);
        font-weight: var(--font-weight-medium);
        color: var(--vscode-textLink-foreground);
        word-break: break-all;
      }

      .memory-meta {
        margin-top: var(--spacing-small);
      }

      .memory-preview {
        font-size: var(--font-size-sm);
        line-height: var(--line-height-normal);
        padding: var(--spacing-medium);
        border-radius: var(--border-radius);
        margin: 0;
        max-height: 200px;
        overflow-y: auto;
      }

      .memory-item.pinned {
        border-left: 3px solid var(--vscode-textLink-foreground);
        padding-left: calc(var(--spacing-medium) - 3px);
      }
    `,
  ];

  @property({ attribute: false }) item?: MemoryViewItem;

  /** Cached markdown render to avoid re-parsing on every Lit update cycle. */
  private cachedPreviewSource: string | null = null;
  private cachedPreviewHtml = '';

  private renderMarkdown(text: string): string {
    if (text !== this.cachedPreviewSource) {
      this.cachedPreviewSource = text;
      this.cachedPreviewHtml = getMd().render(text);
    }
    return this.cachedPreviewHtml;
  }

  private handleOpen(): void {
    if (!this.item) return;
    this.dispatchEvent(
      MemoryViewEvents.openItem({ storagePath: this.item.storagePath }),
    );
  }

  private handleDelete(): void {
    if (!this.item) return;
    this.dispatchEvent(
      MemoryViewEvents.deleteItem({
        storagePath: this.item.storagePath,
        displayPath: this.item.displayPath,
      }),
    );
  }

  private handleTogglePin(): void {
    if (!this.item) return;
    if (this.item.pinned) {
      this.dispatchEvent(
        MemoryViewEvents.unpinItem({ storagePath: this.item.storagePath }),
      );
    } else {
      this.dispatchEvent(
        MemoryViewEvents.pinItem({ storagePath: this.item.storagePath }),
      );
    }
  }

  private renderMeta(item: MemoryViewItem): string {
    const parts: string[] = [];
    if (item.pinned) {
      parts.push('Pinned');
    }
    parts.push(formatBytes(item.size ?? 0));
    parts.push(formatLineCount(item.lineCount ?? 0));
    parts.push(formatUpdatedDate(item.mtime));
    if (item.modifiedBy) {
      parts.push(`by ${item.modifiedBy}`);
    }
    return parts.join(' · ');
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.item) {
      return nothing;
    }

    const previewText = this.item.preview?.trim() ? this.item.preview : null;

    return html`
      <div class="list-item memory-item ${this.item.pinned ? 'pinned' : ''}">
        <div class="list-item-header">
          <div class="memory-path">${this.item.displayPath}</div>
          <vscode-toolbar-container>
            <vscode-toolbar-button
              class="pin-memory-btn"
              icon=${this.item.pinned ? 'pinned' : 'pin'}
              label=${this.item.pinned ? 'Unpin' : 'Pin'}
              title=${this.item.pinned
                ? 'Unpin this memory'
                : 'Pin as core long-term memory'}
              @click=${this.handleTogglePin}
            ></vscode-toolbar-button>
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
          <div class="memory-preview">
            ${previewText
              ? html`<div class="markdown-content">
                  ${unsafeHTML(this.renderMarkdown(previewText))}
                </div>`
              : html`<em class="text-secondary">This note is empty.</em>`}
          </div>
        </vscode-collapsible>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'memory-item': MemoryItem;
  }
}
