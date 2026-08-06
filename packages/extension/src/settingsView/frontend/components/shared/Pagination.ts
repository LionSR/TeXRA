/**
 * Compact pager (status + prev/next controls) for list views.
 * Fires `page-change` with the new page index on navigation.
 */

import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { LitElement, html, css, type TemplateResult, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles and utilities
import { designTokens, commonViewStyles } from '@shared/styles';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { createEvent } from '@shared/utils/events';
import { clamp } from '@utils/core';

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
  const safePage = clamp(page, 0, totalPages - 1);
  const start = safePage * pageSize;
  return {
    paged: items.slice(start, start + pageSize),
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
        font-family: var(--wa-font-family-mono, monospace), monospace;
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

  private goTo(target: number): void {
    const page = clamp(target, 0, this.totalPages - 1);
    if (page === this.page) return;
    this.dispatchEvent(createEvent<PageChangeDetail>('page-change', { page }));
  }

  private renderNavButton(
    icon: TeXRAIconName,
    label: string,
    page: number,
    disabled: boolean,
  ): TemplateResult {
    return html`
      <wa-button
        appearance="outlined"
        variant="neutral"
        size="s"
        aria-label=${label}
        title=${label}
        ?disabled=${disabled}
        @click=${() => this.goTo(page)}
      >
        ${waIcon(icon)}
      </wa-button>
    `;
  }

  override render(): TemplateResult | typeof nothing {
    const { totalPages, page } = this;
    if (totalPages <= 1) return nothing;

    const atFirst = page === 0;
    const atLast = page >= totalPages - 1;

    return html`
      <div class="pagination-bar">
        <span class="pagination-status" role="status" aria-atomic="true">
          ${this.rangeStart}–${this.rangeEnd} of ${this.totalItems}
        </span>
        <div class="pagination-controls">
          ${this.renderNavButton('backward-step', 'First page', 0, atFirst)}
          ${this.renderNavButton(
            'chevron-left',
            'Previous page',
            page - 1,
            atFirst,
          )}
          <span class="pagination-status"> ${page + 1}/${totalPages} </span>
          ${this.renderNavButton('chevron-right', 'Next page', page + 1, atLast)}
          ${this.renderNavButton(
            'forward-step',
            'Last page',
            totalPages - 1,
            atLast,
          )}
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
