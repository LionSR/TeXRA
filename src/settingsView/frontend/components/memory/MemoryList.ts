/**
 * MemoryList component - renders list of saved memory items with pagination.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';

// Local imports - memory view components (side-effect: register)
import './MemoryItem';

// Local imports - shared components (side-effect: register)
import '../shared/Pagination';

// Local imports - shared schemas
import type { MemoryViewItem } from '@shared/schemas';

// Local imports - pagination utility
import {
  paginate,
  DEFAULT_PAGE_SIZE,
  type PageChangeDetail,
} from '../shared/Pagination';

@customElement('memory-list')
export class MemoryList extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .memory-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-medium);
      }
    `,
  ];

  @property({ attribute: false }) items: MemoryViewItem[] = [];

  @state() private page = 0;

  protected override willUpdate(
    changedProperties: Map<string | number | symbol, unknown>,
  ): void {
    // Reset to first page when items change (e.g. refresh, delete, pin/unpin)
    if (changedProperties.has('items')) {
      const totalPages = Math.max(
        1,
        Math.ceil(this.items.length / DEFAULT_PAGE_SIZE),
      );
      if (this.page >= totalPages) {
        this.page = Math.max(0, totalPages - 1);
      }
    }
  }

  private handlePageChange(event: CustomEvent<PageChangeDetail>): void {
    this.page = event.detail.page;
  }

  override render(): TemplateResult {
    if (!this.items.length) {
      return html`<div class="empty-state">
        <span class="codicon codicon-database"></span>
        <p>No saved memories yet.</p>
        <p class="text-secondary">
          Memories are created automatically when the assistant learns something
          worth remembering across conversations.
        </p>
      </div>`;
    }

    const { paged, totalPages: _ } = paginate(
      this.items,
      this.page,
      DEFAULT_PAGE_SIZE,
    );

    return html`
      <list-pagination
        .page=${this.page}
        .totalItems=${this.items.length}
        .pageSize=${DEFAULT_PAGE_SIZE}
        @page-change=${this.handlePageChange}
      ></list-pagination>
      <div class="memory-list">
        ${repeat(
          paged,
          (item) => item.storagePath,
          (item) => html`<memory-item .item=${item}></memory-item>`,
        )}
      </div>
      <list-pagination
        .page=${this.page}
        .totalItems=${this.items.length}
        .pageSize=${DEFAULT_PAGE_SIZE}
        @page-change=${this.handlePageChange}
      ></list-pagination>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'memory-list': MemoryList;
  }
}
