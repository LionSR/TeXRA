/** Single memory entry with metadata and collapsible markdown preview. */

import {
  LitElement,
  html,
  nothing,
  css,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
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
        line-height: var(--line-height-tight, 1.3);
        padding: var(--wa-space-2xs) var(--wa-space-xs);
        border-radius: var(--border-radius);
        margin: 0;
        max-height: 140px;
        overflow-y: auto;
      }

      .memory-preview .markdown-content > :first-child {
        margin-top: 0;
      }
      .memory-preview .markdown-content > :last-child {
        margin-bottom: 0;
      }
      .memory-preview .markdown-content p {
        margin: var(--wa-space-3xs) 0;
      }

      .memory-item.pinned {
        border-left: var(--border-medium) solid var(--wa-color-text-link);
        padding-left: calc(var(--wa-space-xs) - var(--border-medium));
      }
    `,
  ];

  @property({ attribute: false }) item?: MemoryViewItem;

  /** Tracks whether the collapsible has been opened at least once to defer markdown rendering. */
  @state() private contentsOpened = false;

  private requestedPreviewFor: string | null = null;

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
    const { storagePath, pinned } = this.item;
    this.dispatchEvent(
      pinned
        ? MemoryViewEvents.unpinItem({ storagePath })
        : MemoryViewEvents.pinItem({ storagePath }),
    );
  }

  private handleContentsShow(event: Event): void {
    if (event.target !== event.currentTarget) return;
    this.contentsOpened = true;
    this.requestPreviewIfNeeded();
  }

  private requestPreviewIfNeeded(): void {
    if (!this.item || this.item.preview !== undefined) return;
    if (this.item.previewError) return;
    if (this.requestedPreviewFor === this.item.storagePath) return;
    this.requestedPreviewFor = this.item.storagePath;
    this.dispatchEvent(
      MemoryViewEvents.loadPreview({ storagePath: this.item.storagePath }),
    );
  }

  private renderMeta(item: MemoryViewItem): string {
    const parts: string[] = [];
    if (item.pinned) {
      parts.push('Pinned');
    }
    parts.push(formatBytes(item.size ?? 0));
    if (typeof item.lineCount === 'number') {
      parts.push(formatLineCount(item.lineCount));
    }
    parts.push(formatUpdatedDate(item.mtime));
    if (item.modifiedBy) {
      parts.push(`by ${item.modifiedBy}`);
    }
    return parts.join(' · ');
  }

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (!changedProperties.has('item')) return;
    const previous = changedProperties.get('item') as
      | MemoryViewItem
      | undefined;
    if (previous?.storagePath === this.item?.storagePath) {
      if (previous !== this.item && this.item?.preview === undefined) {
        this.requestedPreviewFor = null;
      }
      return;
    }
    this.contentsOpened = false;
    this.requestedPreviewFor = null;
    this.cachedPreviewSource = null;
    this.cachedPreviewHtml = '';
  }

  protected override updated(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has('item') && this.contentsOpened) {
      this.requestPreviewIfNeeded();
    }
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.item) {
      return nothing;
    }

    const previewLoaded = this.item.preview !== undefined;
    const previewError = this.item.previewError === true;
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
                ${!previewLoaded
                  ? previewError
                    ? html`<em class="text-secondary"
                        >Unable to load contents.</em
                      >`
                    : html`<em class="text-secondary">Loading contents...</em>`
                  : previewText
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
