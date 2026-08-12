/**
 * Renders the history list with search highlighting.
 * Pagination is active when there is no search term; during search, a
 * data-level prefilter renders only plausible matches for mark.js highlighting.
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
import { designTokens, commonViewStyles, historyStyles } from '@shared/styles';
import { renderEmptyState } from '@shared/wa/emptyState';

// Side-effect imports - register WA icon component
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared components & pagination utility
import { paginate, type PageChangeDetail } from '../shared/Pagination';

/** History entries are long (instruction + config details), so paginate tighter than the shared default. */
const HISTORY_PAGE_SIZE = 25;

// Local imports - history view
import { HistoryViewEvents } from './events';
import {
  getHistorySearchText,
  getHistorySearchTokens,
  historySearchTextMatches,
} from './historySearch';
import './HistoryItemElement';
import type { HistoryViewState } from './state';

/** Search navigation action (reactive trigger from parent) */
export type SearchAction = 'next' | 'prev' | null;

@customElement('history-list')
export class HistoryList extends LitElement {
  static override styles = [designTokens, commonViewStyles, historyStyles];

  @property({ attribute: false }) items: HistoryItemData[] = [];
  @property({ attribute: false }) state?: HistoryViewState;
  /**
   * Settings-view commands the active host's registry declares
   * `unsupported(...)`; forwarded to each `history-item` so its per-item
   * actions (rerun, setup, export) can hide on a host that can't act on
   * them. See `HistoryTab`'s property of the same name.
   */
  @property({ attribute: false })
  unsupportedCommands: ReadonlySet<string> | null = null;

  @property({ attribute: false }) searchTerm = '';
  @property({ attribute: false }) searchAction: SearchAction = null;
  @property({ attribute: false }) clearSearchTrigger = false;

  @state() private matchCounts: Map<string, number> = new Map();

  private matchOffsets: Map<string, number> = new Map();

  /** Zero-based position of the highlighted match, -1 when none is selected. */
  private searchIndex = -1;

  @state() private searchVersion = 0;

  /** Current zero-based page index (used when not searching). */
  @state() private page = 0;

  @queryAll('history-item')
  private historyItemElements!: Array<
    HTMLElement & {
      item?: HistoryItemData;
      applySearch: (term: string) => Promise<number>;
      getMarks: () => HTMLElement[];
    }
  >;

  private searchTextCache = new WeakMap<HistoryItemData, string>();

  /** Whether pagination is active (no active search). */
  private get paginated(): boolean {
    return !this.searchTerm;
  }

  /** Matches across every item, derived from the per-item counts. */
  private get totalMatches(): number {
    let total = 0;
    for (const count of this.matchCounts.values()) {
      total += count;
    }
    return total;
  }

  private getCachedSearchText(item: HistoryItemData): string {
    const cached = this.searchTextCache.get(item);
    if (cached !== undefined) return cached;

    const text = getHistorySearchText(item);
    this.searchTextCache.set(item, text);
    return text;
  }

  private getSearchCandidates(): HistoryItemData[] {
    const tokens = getHistorySearchTokens(this.searchTerm);
    if (tokens.length === 0) return this.items;

    return this.items.filter((item) =>
      historySearchTextMatches(this.getCachedSearchText(item), tokens),
    );
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
      const { totalPages } = paginate(this.items, this.page, HISTORY_PAGE_SIZE);
      if (this.page >= totalPages) {
        this.page = Math.max(0, totalPages - 1);
      }
    }
  }

  protected updated(changedProps: PropertyValues<this>): void {
    // Apply search after DOM update so candidate items are rendered.
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
    this.searchIndex = -1;
    for (const item of this.historyItemElements ?? []) {
      void item.applySearch?.('');
    }
    this.updateMatchCount();
  }

  private performNavigate(direction: 'next' | 'prev'): void {
    const total = this.totalMatches;
    if (total === 0) return;
    const delta = direction === 'next' ? 1 : -1;
    this.searchIndex = (this.searchIndex + delta + total) % total;
    this.updateMatchCount();
    this.requestUpdate();
  }

  private updateMatchCount(): void {
    const total = this.totalMatches;
    const display = total === 0 ? '' : `${this.searchIndex + 1}/${total}`;
    this.dispatchEvent(HistoryViewEvents.matchCount({ display }));
  }

  private getHighlightedMatchIndex(itemId: string): number | null {
    if (this.searchIndex < 0) return null;

    const globalIndex = this.searchIndex;
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
    historyItems.forEach((element, i) => {
      const itemId = element.item?.id;
      if (itemId == null) return;

      const count = counts[i] ?? 0;
      nextCounts.set(itemId, count);
      if (count > 0) {
        nextOffsets.set(itemId, total);
      }
      total += count;
    });

    this.matchOffsets = nextOffsets;
    this.matchCounts = nextCounts;
    this.searchIndex = total > 0 ? 0 : -1;
    this.updateMatchCount();
    if (total > 0) {
      this.requestUpdate();
    }
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

  private renderPagination(): TemplateResult | string {
    if (!this.paginated) return '';
    return html`<list-pagination
      .page=${this.page}
      .totalItems=${this.items.length}
      .pageSize=${HISTORY_PAGE_SIZE}
      @page-change=${this.handlePageChange}
    ></list-pagination>`;
  }

  override render(): TemplateResult {
    if (!this.items.length) {
      return renderEmptyState({
        icon: 'clock-rotate-left',
        title: 'No history items found.',
        body: 'History is recorded when you run agent commands. Past results will appear here.',
        headingTag: 'h3',
        className: 'empty-state',
      });
    }

    const hasMatches = this.totalMatches > 0;
    const forceOpen = Boolean(this.searchTerm && hasMatches);

    // When searching, render only plausible matches; otherwise paginate.
    const displayItems = this.paginated
      ? paginate(this.items, this.page, HISTORY_PAGE_SIZE).paged
      : this.getSearchCandidates();

    // A search that excludes every entry would otherwise render an empty
    // container with no count or message — show explicit no-results feedback.
    if (this.searchTerm && displayItems.length === 0) {
      return renderEmptyState({
        icon: 'clock-rotate-left',
        title: 'No history items match your search.',
        body: 'Try a different search term or clear the search.',
        headingTag: 'h3',
        className: 'empty-state',
      });
    }

    return html`
      ${this.renderPagination()}
      <div class="history-container" role="list">
        ${repeat(
          displayItems,
          (item) => item.id,
          (item) => html`
            <history-item
              role="listitem"
              .item=${item}
              .unsupportedCommands=${this.unsupportedCommands}
              .open=${
                forceOpen || Boolean(this.state?.toggleStates.get(item.id))
              }
              .highlightedMatchIndex=${this.getHighlightedMatchIndex(item.id)}
              @history-toggle=${this.handleToggle}
            ></history-item>
          `,
        )}
      </div>
      ${this.renderPagination()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'history-list': HistoryList;
  }
}
