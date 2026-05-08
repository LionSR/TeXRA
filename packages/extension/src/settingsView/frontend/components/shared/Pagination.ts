/**
 * Pagination component — Unix-style page navigation for list views.
 *
 * Displays a compact status bar with page info and prev/next controls,
 * inspired by Unix pagers like `less`.
 *
 * Fires `page-change` events with the new page index when the user navigates.
 */

// Third-party imports
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { LitElement, html, css, type TemplateResult, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles and utilities
import { designTokens, commonViewStyles } from '@shared/styles';
import { TEXRA_ICON_LIBRARY } from '@shared/wa';
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
        padding: var(--wa-space-2xs) 0;
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
        gap: var(--wa-space-2xs);
      }

      .pagination-controls wa-button::part(base) {
        min-width: var(--height-control);
        min-height: var(--height-control);
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
          <wa-button
            appearance="outlined"
            variant="neutral"
            size="small"
            aria-label="First page"
            title="First page"
            ?disabled=${atFirst}
            @click=${this.goFirst}
          >
            <wa-icon
              library=${TEXRA_ICON_LIBRARY}
              name="backward-step"
              variant="solid"
            ></wa-icon>
          </wa-button>
          <wa-button
            appearance="outlined"
            variant="neutral"
            size="small"
            aria-label="Previous page"
            title="Previous page"
            ?disabled=${atFirst}
            @click=${this.goPrev}
          >
            <wa-icon
              library=${TEXRA_ICON_LIBRARY}
              name="chevron-left"
              variant="solid"
            ></wa-icon>
          </wa-button>
          <span class="pagination-status">
            ${this.page + 1}/${this.totalPages}
          </span>
          <wa-button
            appearance="outlined"
            variant="neutral"
            size="small"
            aria-label="Next page"
            title="Next page"
            ?disabled=${atLast}
            @click=${this.goNext}
          >
            <wa-icon
              library=${TEXRA_ICON_LIBRARY}
              name="chevron-right"
              variant="solid"
            ></wa-icon>
          </wa-button>
          <wa-button
            appearance="outlined"
            variant="neutral"
            size="small"
            aria-label="Last page"
            title="Last page"
            ?disabled=${atLast}
            @click=${this.goLast}
          >
            <wa-icon
              library=${TEXRA_ICON_LIBRARY}
              name="forward-step"
              variant="solid"
            ></wa-icon>
          </wa-button>
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
