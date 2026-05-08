/**
 * MemoryItem component - displays a single memory entry with metadata and preview.
 */

// Third-party imports
import { LitElement, html, nothing, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import '@awesome.me/webawesome/dist/components/details/details.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import type { MemoryViewItem } from '@shared/schemas';
import { markdownStyles } from '@shared/styles/markdownStyles';
import {
  formatBytes,
  formatLineCount,
  formatUpdatedDate,
} from '@shared/utils/string';
import { getLightweightMd } from '@shared/highlighting/lightweightMd';
import { renderIconActionButton } from '@shared/wa/actionButtons';

// Local imports - memory view events
import { MemoryViewEvents } from './events';

@customElement('memory-item')
export class MemoryItem extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    markdownStyles,
    css`
      :host {
        display: block;
      }

      .memory-path {
        font-family: var(--wa-font-family-mono, monospace), monospace;
        font-size: var(--font-size);
        font-weight: var(--font-weight-medium);
        color: var(--wa-color-text-link);
        word-break: break-all;
      }

      .memory-meta {
        margin-top: var(--wa-space-2xs);
      }

      .memory-preview {
        font-size: var(--font-size-sm);
        line-height: var(--line-height-normal);
        padding: var(--wa-space-xs);
        border-radius: var(--border-radius);
        margin: 0;
        max-height: 200px;
        overflow-y: auto;
      }

      .memory-item.pinned {
        border-left: 3px solid var(--wa-color-text-link);
        padding-left: calc(var(--wa-space-xs) - 3px);
      }
    `,
  ];

  @property({ attribute: false }) item?: MemoryViewItem;

  /** Tracks whether the collapsible has been opened at least once to defer markdown rendering. */
  @state() private contentsOpened = false;

  /** Cached markdown render to avoid re-parsing on every Lit update cycle. */
  private cachedPreviewSource: string | null = null;
  private cachedPreviewHtml = '';

  private renderMarkdown(text: string): string {
    if (text !== this.cachedPreviewSource) {
      this.cachedPreviewSource = text;
      this.cachedPreviewHtml = getLightweightMd().render(text);
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

  private handleContentsShow(event: Event): void {
    if (event.target !== event.currentTarget) return;
    this.contentsOpened = true;
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
          <div class="action-button-group">
            ${renderIconActionButton({
              icon: this.item.pinned ? 'thumbtack-slash' : 'thumbtack',
              label: this.item.pinned ? 'Unpin' : 'Pin',
              title: this.item.pinned
                ? 'Unpin this memory'
                : 'Pin as core long-term memory',
              onClick: this.handleTogglePin,
            })}
            ${renderIconActionButton({
              icon: 'file-export',
              label: 'Open',
              title: 'Open in editor',
              onClick: this.handleOpen,
            })}
            ${renderIconActionButton({
              icon: 'trash',
              label: 'Delete',
              title: 'Delete this memory',
              onClick: this.handleDelete,
            })}
          </div>
        </div>
        <div class="text-secondary memory-meta">
          ${this.renderMeta(this.item)}
        </div>
        <wa-details
          class="collapsible"
          summary="Contents"
          @wa-show=${this.handleContentsShow}
        >
          ${this.contentsOpened
            ? html`<div class="memory-preview">
                ${previewText
                  ? html`<div class="markdown-content">
                      ${unsafeHTML(this.renderMarkdown(previewText))}
                    </div>`
                  : html`<em class="text-secondary">This note is empty.</em>`}
              </div>`
            : nothing}
        </wa-details>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'memory-item': MemoryItem;
  }
}
