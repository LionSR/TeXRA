/**
 * Pagination component — Unix-style page navigation for list views.
 *
 * Displays a compact status bar with page info and prev/next controls,
 * inspired by Unix pagers like `less`.
 *
 * Fires `page-change` events with the new page index when the user navigates.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles and utilities
import { designTokens, commonViewStyles } from '@shared/styles';
import { createEvent } from '@shared/utils/events';

/** Detail payload for the `page-change` custom event. */
export interface PageChangeDetail {
  page: number;
}

/** Default number of items per page. */
export const DEFAULT_PAGE_SIZE = 100;

/**
 * Compute the page slice for a given items array.
 * Returns `{ paged, totalPages }` where `paged` is the current page's items.
 */
export function paginate<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
): { paged: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * pageSize;
  return {
    paged: items.slice(start, start + pageSize) as T[],
    totalPages,
  };
}

@customElement('list-pagination')
export class Pagination extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    css`
      :host {
        display: block;
      }

      .pagination-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-small) 0;
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        user-select: none;
      }

      .pagination-status {
        font-family: var(--texra-editor-font-family, monospace), monospace;
        letter-spacing: 0.02em;
      }

      .pagination-controls {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
      }

      .page-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: var(--height-control);
        height: var(--height-control);
        padding: 0 var(--spacing-small);
        font-size: var(--font-size-xs);
        font-family: var(--texra-editor-font-family, monospace), monospace;
        color: var(--color-text-secondary);
        background: none;
        border: var(--border-thin) solid var(--color-border);
        border-radius: var(--border-radius);
        cursor: pointer;
        transition:
          color var(--transition-fast),
          border-color var(--transition-fast);
      }

      .page-btn:hover:not(:disabled) {
        color: var(--texra-foreground);
        border-color: var(--texra-focusBorder);
      }

      .page-btn:active:not(:disabled) {
        background: var(
          --texra-toolbar-activeBackground,
          rgba(99, 102, 103, 0.31)
        );
      }

      .page-btn:disabled {
        opacity: var(--opacity-disabled);
        cursor: default;
      }

      .page-btn:focus-visible {
        outline: var(--border-thin) solid var(--texra-focusBorder);
        outline-offset: 1px;
      }
    `,
  ];

  /** Current zero-based page index. */
  @property({ type: Number }) page = 0;

  /** Total number of items across all pages. */
  @property({ type: Number }) totalItems = 0;

  /** Items per page. */
  @property({ type: Number }) pageSize = DEFAULT_PAGE_SIZE;

  private get totalPages(): number {
    return Math.max(1, Math.ceil(this.totalItems / this.pageSize));
  }

  private get rangeStart(): number {
    return this.totalItems === 0 ? 0 : this.page * this.pageSize + 1;
  }

  private get rangeEnd(): number {
    return Math.min((this.page + 1) * this.pageSize, this.totalItems);
  }

  private emitPageChange(page: number): void {
    this.dispatchEvent(createEvent<PageChangeDetail>('page-change', { page }));
  }

  private goFirst(): void {
    if (this.page > 0) this.emitPageChange(0);
  }

  private goPrev(): void {
    if (this.page > 0) this.emitPageChange(this.page - 1);
  }

  private goNext(): void {
    if (this.page < this.totalPages - 1) this.emitPageChange(this.page + 1);
  }

  private goLast(): void {
    if (this.page < this.totalPages - 1)
      this.emitPageChange(this.totalPages - 1);
  }

  override render(): TemplateResult | typeof nothing {
    if (this.totalPages <= 1) return nothing;

    const atFirst = this.page === 0;
    const atLast = this.page >= this.totalPages - 1;

    return html`
      <div class="pagination-bar">
        <span class="pagination-status">
          ${this.rangeStart}–${this.rangeEnd} of ${this.totalItems}
        </span>
        <div class="pagination-controls">
          <button
            class="page-btn"
            title="First page"
            ?disabled=${atFirst}
            @click=${this.goFirst}
          >
            «
          </button>
          <button
            class="page-btn"
            title="Previous page"
            ?disabled=${atFirst}
            @click=${this.goPrev}
          >
            ‹
          </button>
          <span class="pagination-status">
            ${this.page + 1}/${this.totalPages}
          </span>
          <button
            class="page-btn"
            title="Next page"
            ?disabled=${atLast}
            @click=${this.goNext}
          >
            ›
          </button>
          <button
            class="page-btn"
            title="Last page"
            ?disabled=${atLast}
            @click=${this.goLast}
          >
            »
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'list-pagination': Pagination;
  }
}
