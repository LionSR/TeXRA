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
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import '@awesome.me/webawesome/dist/components/details/details.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/button-group/button-group.js';
import '@awesome.me/webawesome/dist/components/tooltip/tooltip.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import type { MemoryViewItem } from '@shared/schemas';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';
import { markdownStyles } from '@shared/styles/markdownStyles';
import { getLightweightMd } from '@shared/highlighting/lightweightMd';
import { renderIconActionButtonParts } from '@shared/wa/actionButtons';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { metaStripStyles, renderDotMeta } from '@shared/wa/metaStrip';
import {
  formatBytes,
  formatResultCount,
  formatShortDateTime,
} from '@utils/text/stringUtils';

@customElement('memory-item')
export class MemoryItem extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    markdownStyles,
    metaStripStyles,
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

      .memory-contents {
        margin-top: var(--wa-space-3xs);
      }

      .memory-preview {
        font-size: var(--font-size-sm);
        line-height: var(--line-height-tight, 1.3);
        padding: var(--wa-space-3xs) var(--wa-space-2xs);
        border-radius: var(--border-radius);
        margin: 0;
        max-height: clamp(220px, 45vh, 420px);
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
        border-inline-start: var(--border-medium) solid
          var(--wa-color-text-link);
        padding-inline-start: calc(var(--wa-space-xs) - var(--border-medium));
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
    postMessage(SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FILE, {
      storagePath: this.item.storagePath,
    });
  }

  private handleDelete(): void {
    if (!this.item) return;
    postMessage(SETTINGS_VIEW_COMMANDS.DELETE_MEMORY, {
      storagePath: this.item.storagePath,
      displayPath: this.item.displayPath,
    });
  }

  private handleTogglePin(): void {
    if (!this.item) return;
    const { storagePath, pinned } = this.item;
    postMessage(
      pinned
        ? SETTINGS_VIEW_COMMANDS.UNPIN_MEMORY
        : SETTINGS_VIEW_COMMANDS.PIN_MEMORY,
      { storagePath },
    );
  }

  private handleContentsShow(event: Event): void {
    if (event.target !== event.currentTarget) return;
    this.contentsOpened = true;
    this.requestPreviewIfNeeded();
  }

  private handleContentsHide(event: Event): void {
    if (event.target !== event.currentTarget) return;
    this.contentsOpened = false;
  }

  private requestPreviewIfNeeded(): void {
    if (!this.item || this.item.preview !== undefined) return;
    if (this.item.previewError) return;
    if (this.requestedPreviewFor === this.item.storagePath) return;
    this.requestedPreviewFor = this.item.storagePath;
    postMessage(SETTINGS_VIEW_COMMANDS.GET_MEMORY_PREVIEW, {
      storagePath: this.item.storagePath,
    });
  }

  private renderMeta(item: MemoryViewItem): TemplateResult {
    const parts: string[] = [];
    if (item.pinned) {
      parts.push('Pinned');
    }
    parts.push(formatBytes(item.size ?? 0));
    if (typeof item.lineCount === 'number') {
      parts.push(formatResultCount(item.lineCount, 'line'));
    }
    const updated = formatShortDateTime(item.mtime);
    parts.push(updated ? `Updated ${updated}` : 'Updated: unknown');
    if (item.modifiedBy) {
      parts.push(`by ${item.modifiedBy}`);
    }
    return renderDotMeta(parts);
  }

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (!changedProperties.has('item')) return;
    const previous = changedProperties.get('item');
    if (previous?.storagePath === this.item?.storagePath) {
      if (previous !== this.item && this.item?.preview === undefined) {
        this.requestedPreviewFor = null;
      }
      return;
    }
    this.contentsOpened = this.item?.pinned ?? false;
    this.requestedPreviewFor = null;
    this.cachedPreviewSource = null;
    this.cachedPreviewHtml = '';
  }

  protected override updated(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has('item') && this.contentsOpened) {
      this.requestPreviewIfNeeded();
    }
  }

  /**
   * Pin / Open / Delete cluster. Tooltips render after the group: a
   * wa-button-group fuses corners via CSS ::slotted(:first/:last-child), so a
   * slotted <wa-tooltip> would break the segmenting — hence
   * `renderIconActionButtonParts` rather than the concatenated
   * `renderIconActionButton`. Each <wa-tooltip> anchors by `for` within this
   * element's shadow root, so the static ids stay unique per instance even
   * when many memory-item rows are on screen.
   */
  private renderActionGroup(): TemplateResult {
    const pinned = this.item?.pinned === true;
    const memoryName = this.item?.displayPath?.split('/').pop() ?? '';
    const actions = [
      {
        id: 'memory-pin-button',
        icon: (pinned ? 'thumbtack-slash' : 'thumbtack') as TeXRAIconName,
        label: pinned ? 'Unpin' : 'Pin',
        tooltip: pinned ? 'Unpin this memory' : 'Pin as core long-term memory',
        onClick: this.handleTogglePin,
      },
      {
        id: 'memory-open-button',
        icon: 'file-export' as TeXRAIconName,
        label: 'Open',
        tooltip: 'Open in editor',
        onClick: this.handleOpen,
      },
      {
        id: 'memory-delete-button',
        icon: 'trash' as TeXRAIconName,
        label: 'Delete',
        tooltip: 'Delete this memory',
        onClick: this.handleDelete,
      },
    ].map((action) => ({
      id: action.id,
      // Name each control by the memory it acts on: three identical "Delete"s
      // down a list tell a screen-reader user nothing about which one they hit.
      ...renderIconActionButtonParts({
        ...action,
        label: memoryName ? `${action.label}: ${memoryName}` : action.label,
      }),
    }));
    return html`
      <wa-button-group label="Memory actions">
        ${repeat(
          actions,
          (action) => action.id,
          (action) => action.button,
        )}
      </wa-button-group>
      ${repeat(
        actions,
        (action) => action.id,
        (action) => action.tooltip,
      )}
    `;
  }

  private renderPreviewBody(item: MemoryViewItem): TemplateResult {
    if (item.preview === undefined) {
      return item.previewError === true
        ? html`<em class="text-secondary">Unable to load contents.</em>`
        : html`<em class="text-secondary">Loading contents...</em>`;
    }
    if (!item.preview.trim()) {
      return html`<em class="text-secondary">This note is empty.</em>`;
    }
    return html`<div class="markdown-content">
      ${unsafeHTML(this.renderMarkdown(item.preview))}
    </div>`;
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.item) {
      return nothing;
    }

    return html`
      <div
        class=${classMap({
          'list-item': true,
          'memory-item': true,
          pinned: this.item.pinned === true,
        })}
      >
        <div class="list-item-header">
          <div class="memory-path">${this.item.displayPath}</div>
          ${this.renderActionGroup()}
        </div>
        <div class="text-secondary meta-strip">
          ${this.renderMeta(this.item)}
        </div>
        <wa-details
          class="collapsible-quiet memory-contents"
          summary="Contents"
          ?open=${this.contentsOpened}
          @wa-show=${this.handleContentsShow}
          @wa-hide=${this.handleContentsHide}
        >
          ${
            this.contentsOpened
              ? html`<div class="memory-preview">
                  ${this.renderPreviewBody(this.item)}
                </div>`
              : nothing
          }
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
