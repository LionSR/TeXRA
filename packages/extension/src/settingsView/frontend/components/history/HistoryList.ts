/**
 * Renders the history list with search highlighting.
 * Pagination is active when there is no search term; during search, all
 * items are rendered so match navigation works across the full list.
 */

import {
  LitElement,
  html,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, queryAll, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared
import type { HistoryItem as HistoryItemData } from '@shared/schemas';
import { designTokens, commonViewStyles } from '@shared/styles';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared components & pagination utility
import { paginate, type PageChangeDetail } from '../shared/Pagination';

/** History entries are long (instruction + config details), so paginate tighter than the shared default. */
const HISTORY_PAGE_SIZE = 25;

// Local imports - history view
import { HistoryViewEvents } from './events';
import './HistoryItemElement';
import { historyStyles } from '@shared/styles/historyStyles';
import type { HistoryViewState } from './state';

/** Search navigation action (reactive trigger from parent) */
export type SearchAction = 'next' | 'prev' | null;

@customElement('history-list')
export class HistoryList extends LitElement {
  static override styles = [designTokens, commonViewStyles, historyStyles];

  @property({ attribute: false }) items: HistoryItemData[] = [];
  @property({ attribute: false }) state?: HistoryViewState;

  @property({ attribute: false }) searchTerm = '';
  @property({ attribute: false }) searchAction: SearchAction = null;
  @property({ attribute: false }) clearSearchTrigger = false;

  @state() private matchCounts: Map<string, number> = new Map();

  private matchOffsets: Map<string, number> = new Map();

  @state() private searchVersion = 0;

  /** Current zero-based page index (used when not searching). */
  @state() private page = 0;

  @queryAll('history-item')
  private historyItemElements!: Array<
    HTMLElement & {
      applySearch: (term: string) => Promise<number>;
      getMarks: () => HTMLElement[];
    }
  >;

  /** Whether pagination is active (no active search). */
  private get paginated(): boolean {
    return !this.searchTerm;
  }

  protected willUpdate(changedProperties: PropertyValues<this>): void {
    if (
      changedProperties.has('clearSearchTrigger') &&
      this.clearSearchTrigger
    ) {
      this.clearSearch();
      this.dispatchEvent(HistoryViewEvents.searchClearComplete());
    }

    if (changedProperties.has('searchTerm')) {
      if (this.searchTerm) {
        // Reset page when entering search mode
        this.page = 0;
      } else {
        // Clear marks immediately when search is cleared; new search
        // terms are deferred to updated() so the full DOM is available.
        this.clearSearch();
      }
    }

    if (changedProperties.has('searchAction') && this.searchAction) {
      this.performNavigate(this.searchAction);
      this.dispatchEvent(HistoryViewEvents.searchNavigateComplete());
    }

    // Clamp page when items change (e.g. delete)
    if (changedProperties.has('items') && this.paginated) {
      const totalPages = Math.max(
        1,
        Math.ceil(this.items.length / HISTORY_PAGE_SIZE),
      );
      if (this.page >= totalPages) {
        this.page = Math.max(0, totalPages - 1);
      }
    }
  }

  protected updated(changedProps: Map<string, unknown>): void {
    // Apply search after DOM update so all items are rendered
    // (pagination is disabled during search, so we need the full DOM).
    if (
      this.searchTerm &&
      (changedProps.has('searchTerm') || changedProps.has('items'))
    ) {
      const version = ++this.searchVersion;
      void this.applySearchToItems(this.searchTerm, version);
    }
  }

  private clearSearch(): void {
    this.matchCounts = new Map();
    this.matchOffsets = new Map();
    ++this.searchVersion;
    this.state?.setSearchIndex(-1);
    this.state?.setTotalMatches(0);
    this.clearItemMarks();
    this.updateMatchCount();
  }

  private performNavigate(direction: 'next' | 'prev'): void {
    if (!this.state || this.state.totalMatches === 0) return;
    const delta = direction === 'next' ? 1 : -1;
    const nextIndex =
      (this.state.searchIndex + delta + this.state.totalMatches) %
      this.state.totalMatches;
    this.state.setSearchIndex(nextIndex);
    this.updateMatchCount();
    this.requestUpdate();
  }

  private updateMatchCount(): void {
    if (!this.state) return;
    const total = this.state.totalMatches;
    const display = total === 0 ? '' : `${this.state.searchIndex + 1}/${total}`;
    this.dispatchEvent(HistoryViewEvents.matchCount({ display }));
  }

  private getHighlightedMatchIndex(itemId: string): number | null {
    if (!this.state || this.state.searchIndex < 0) return null;

    const globalIndex = this.state.searchIndex;
    const itemOffset = this.matchOffsets.get(itemId);
    if (itemOffset == null) return null;

    const count = this.matchCounts.get(itemId) ?? 0;
    if (globalIndex >= itemOffset && globalIndex < itemOffset + count) {
      return globalIndex - itemOffset;
    }
    return null;
  }

  private async applySearchToItems(
    term: string,
    version: number,
  ): Promise<void> {
    const historyItems = [...(this.historyItemElements ?? [])];
    const counts = await Promise.all(
      historyItems.map(
        (item) => item.applySearch?.(term) ?? Promise.resolve(0),
      ),
    );
    if (version !== this.searchVersion) {
      return;
    }

    const nextCounts = new Map<string, number>();
    const nextOffsets = new Map<string, number>();
    let total = 0;
    this.items.forEach((item, i) => {
      const count = counts[i] ?? 0;
      nextCounts.set(item.id, count);
      if (count > 0) {
        nextOffsets.set(item.id, total);
      }
      total += count;
    });

    this.matchOffsets = nextOffsets;
    this.matchCounts = nextCounts;
    this.state?.setTotalMatches(total);
    if (total > 0) {
      this.state?.setSearchIndex(0);
      this.updateMatchCount();
      this.requestUpdate();
    } else {
      this.state?.setSearchIndex(-1);
      this.updateMatchCount();
    }
  }

  private clearItemMarks(): void {
    const items = [...(this.historyItemElements ?? [])];
    void Promise.all(
      items.map((item) => item.applySearch?.('') ?? Promise.resolve(0)),
    );
  }

  private handleToggle(
    event: CustomEvent<{ historyId: string; open: boolean }>,
  ): void {
    if (!this.state || this.searchTerm) return;
    this.state.toggleStates.set(event.detail.historyId, event.detail.open);
  }

  private handlePageChange(event: CustomEvent<PageChangeDetail>): void {
    this.page = event.detail.page;
  }

  override render(): TemplateResult {
    if (!this.items.length) {
      return html`<div class="empty-state">
        <wa-icon library="texra" name="history"></wa-icon>
        <p>No history items found.</p>
        <p class="text-secondary">
          History is recorded when you run agent commands. Past results will
          appear here.
        </p>
      </div>`;
    }

    const hasMatches = (this.state?.totalMatches ?? 0) > 0;
    const forceOpen = Boolean(this.searchTerm && hasMatches);

    // When searching, show all items; otherwise paginate
    const displayItems = this.paginated
      ? paginate(this.items, this.page, HISTORY_PAGE_SIZE).paged
      : this.items;

    return html`
      ${this.paginated
        ? html`<list-pagination
            .page=${this.page}
            .totalItems=${this.items.length}
            .pageSize=${HISTORY_PAGE_SIZE}
            @page-change=${this.handlePageChange}
          ></list-pagination>`
        : ''}
      <div class="history-container">
        ${repeat(
          displayItems,
          (item) => item.id,
          (item) => html`
            <history-item
              .item=${item}
              .open=${forceOpen ||
              Boolean(this.state?.toggleStates.get(item.id))}
              .highlightedMatchIndex=${this.getHighlightedMatchIndex(item.id)}
              @history-toggle=${this.handleToggle}
            ></history-item>
          `,
        )}
      </div>
      ${this.paginated
        ? html`<list-pagination
            .page=${this.page}
            .totalItems=${this.items.length}
            .pageSize=${HISTORY_PAGE_SIZE}
            @page-change=${this.handlePageChange}
          ></list-pagination>`
        : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'history-list': HistoryList;
  }
}
