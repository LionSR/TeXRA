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

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - memory view components (side-effect: register)
import './MemoryItem';

// Local imports - shared schemas
import type { MemoryViewItem } from '@shared/schemas';

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
      }
    `,
  ];

  @property({ attribute: false }) items: MemoryViewItem[] = [];

  @state() private page = 0;

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has('items')) {
      const previous = changedProperties.get('items') as
        | MemoryViewItem[]
        | undefined;
      if (!hasSameMemoryOrder(previous, this.items)) {
        this.page = 0;
      }
    }
  }

  private handlePageChange(event: CustomEvent<PageChangeDetail>): void {
    this.page = event.detail.page;
  }

  override render(): TemplateResult {
    if (!this.items.length) {
      return html`<div class="empty-state">
        <wa-icon library="texra" name="database"></wa-icon>
        <p>No saved memories yet.</p>
        <p class="text-secondary">
          Memories are created automatically when the assistant learns something
          worth remembering across conversations.
        </p>
      </div>`;
    }

    const { paged } = paginate(this.items, this.page, DEFAULT_PAGE_SIZE);

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
