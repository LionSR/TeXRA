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
import { designTokens, commonViewStyles } from '@shared/styles';
import { renderEmptyState } from '@shared/wa/emptyState';
import { historyStyles } from '@shared/styles/historyStyles';

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

  protected updated(changedProps: Map<string, unknown>): void {
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
        icon: 'history',
        title: 'No history items found.',
        body: 'History is recorded when you run agent commands. Past results will appear here.',
        headingTag: 'h3',
        className: 'empty-state',
      });
    }

    const hasMatches = (this.state?.totalMatches ?? 0) > 0;
    const forceOpen = Boolean(this.searchTerm && hasMatches);

    // When searching, render only plausible matches; otherwise paginate.
    const displayItems = this.paginated
      ? paginate(this.items, this.page, HISTORY_PAGE_SIZE).paged
      : this.getSearchCandidates();

    // A search that excludes every entry would otherwise render an empty
    // container with no count or message — show explicit no-results feedback.
    if (this.searchTerm && displayItems.length === 0) {
      return renderEmptyState({
        icon: 'history',
        title: 'No history items match your search.',
        headingTag: 'h3',
        className: 'empty-state',
      });
    }

    return html`
      ${this.renderPagination()}
      <div class="history-container">
        ${repeat(
          displayItems,
          (item) => item.id,
          (item) => html`
            <history-item
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
