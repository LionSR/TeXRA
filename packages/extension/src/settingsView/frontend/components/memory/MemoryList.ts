/** Renders list of saved memory items with pagination. */

import {
  LitElement,
  html,
  css,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared
import type { MemoryViewItem } from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';
import { renderEmptyState } from '@shared/wa/emptyState';

// Local imports - memory view components (side-effect: register)
import './MemoryItem';

// Local imports - pagination
import {
  paginate,
  DEFAULT_PAGE_SIZE,
  type PageChangeDetail,
} from '../shared/Pagination';

function hasSameMemoryOrder(
  previous: readonly MemoryViewItem[] | undefined,
  next: readonly MemoryViewItem[],
): boolean {
  if (!previous || previous.length !== next.length) return false;
  return previous.every(
    (item, index) => item.storagePath === next[index]?.storagePath,
  );
}

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
        gap: var(--wa-space-xs);
        margin: 0;
        padding: 0;
        list-style: none;
      }
    `,
  ];

  @property({ attribute: false }) items: MemoryViewItem[] = [];

  @state() private page = 0;

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has('items')) {
      const previous = changedProperties.get('items');
      if (!hasSameMemoryOrder(previous, this.items)) {
        this.page = 0;
      }
    }
  }

  private handlePageChange(event: CustomEvent<PageChangeDetail>): void {
    this.page = event.detail.page;
  }

  private renderPagination(): TemplateResult {
    return html`<list-pagination
      .page=${this.page}
      .totalItems=${this.items.length}
      .pageSize=${DEFAULT_PAGE_SIZE}
      @page-change=${this.handlePageChange}
    ></list-pagination>`;
  }

  override render(): TemplateResult {
    if (!this.items.length) {
      return renderEmptyState({
        icon: 'database',
        title: 'No saved memories yet.',
        body: 'Memories are created automatically when the assistant learns something worth remembering across conversations.',
        headingTag: 'h3',
        className: 'empty-state',
      });
    }

    const { paged } = paginate(this.items, this.page, DEFAULT_PAGE_SIZE);

    return html`
      ${this.renderPagination()}
      <ul class="memory-list" aria-label="Saved memories">
        ${repeat(
          paged,
          (item) => item.storagePath,
          (item) => html` <li><memory-item .item=${item}></memory-item></li> `,
        )}
      </ul>
      ${this.renderPagination()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'memory-list': MemoryList;
  }
}
