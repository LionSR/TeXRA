/**
 * HistoryList component - renders list of history items with search functionality.
 * Receives search state via reactive properties and handles navigation.
 */

// Third-party imports
import {
  LitElement,
  html,
  type PropertyValues,
  type TemplateResult,
} from 'lit';
import { customElement, property, queryAll, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import { historyViewStyles } from './styles';

// Local imports - history view components (side-effect: register)
import './HistoryItem';

// Local imports - history view events
import { HistoryViewEvents } from './events';

// Local imports - history view state
import type { HistoryViewState } from './state';

// Local imports - shared schemas
import type { HistoryItem as HistoryItemData } from '@shared/schemas';

/** Search navigation action (reactive trigger from parent) */
export type SearchAction = 'next' | 'prev' | null;

@customElement('history-list')
export class HistoryList extends LitElement {
  static override styles = [designTokens, commonViewStyles, historyViewStyles];

  @property({ attribute: false }) items: HistoryItemData[] = [];
  @property({ attribute: false }) state?: HistoryViewState;

  // === Reactive search properties (Lit-native Phase 9) ===
  /** Search term from parent - triggers search when changed */
  @property({ type: String }) searchTerm = '';
  /** Navigation action trigger - 'next' | 'prev' | null */
  @property({ type: String }) searchAction: SearchAction = null;
  /** Trigger to clear search state (set true to clear, resets to false) */
  @property({ type: Boolean }) clearSearchTrigger = false;

  /** Match counts per item, keyed by item.id - used to compute highlighted index */
  @state() private matchCounts: Map<string, number> = new Map();

  @state() private searchVersion = 0;

  @queryAll('history-item')
  private historyItemElements!: Array<
    HTMLElement & {
      applySearch: (term: string) => Promise<number>;
      getMarks: () => HTMLElement[];
    }
  >;

  /**
   * React to property changes (Lit-native approach).
   * Replaces imperative method calls from parent with reactive updates.
   */
  protected willUpdate(changedProperties: PropertyValues<this>): void {
    // Handle clearSearchTrigger - clear search state
    if (
      changedProperties.has('clearSearchTrigger') &&
      this.clearSearchTrigger
    ) {
      this.performClearSearch();
      // Dispatch event to reset the trigger
      this.dispatchEvent(HistoryViewEvents.searchClearComplete());
    }

    // Handle searchTerm changes - apply search
    if (changedProperties.has('searchTerm')) {
      this.performSearch(this.searchTerm);
    }

    // Handle searchAction - navigate to next/prev match
    if (changedProperties.has('searchAction') && this.searchAction) {
      this.performNavigate(this.searchAction);
      // Dispatch event to reset the action
      this.dispatchEvent(HistoryViewEvents.searchNavigateComplete());
    }
  }

  protected updated(changedProps: Map<string, unknown>): void {
    // Re-apply search when items change (e.g., new history loaded)
    if (changedProps.has('items') && this.searchTerm) {
      const version = ++this.searchVersion;
      void this.applySearchToItems(this.searchTerm, version);
    }
  }

  // === Internal search operations (called from willUpdate) ===

  private performClearSearch(): void {
    this.searchVersion += 1;
    this.matchCounts = new Map();
    this.state?.setSearchIndex(-1);
    this.state?.setTotalMatches(0);
    this.clearItemMarks();
    this.updateMatchCount();
  }

  private performSearch(term: string): void {
    const version = ++this.searchVersion;
    if (!term) {
      this.state?.setSearchIndex(-1);
      this.state?.setTotalMatches(0);
      this.clearItemMarks();
      this.updateMatchCount();
      return;
    }
    void this.applySearchToItems(term, version);
  }

  private performNavigate(direction: 'next' | 'prev'): void {
    if (!this.state || this.state.totalMatches === 0) return;
    const delta = direction === 'next' ? 1 : -1;
    const nextIndex =
      (this.state.searchIndex + delta + this.state.totalMatches) %
      this.state.totalMatches;
    this.state.setSearchIndex(nextIndex);
    this.updateMatchCount();
    // Trigger re-render to update highlightedMatchIndex props
    this.requestUpdate();
  }

  private updateMatchCount(): void {
    if (!this.state) return;
    const total = this.state.totalMatches;
    const display = total === 0 ? '' : `${this.state.searchIndex + 1}/${total}`;
    this.dispatchEvent(HistoryViewEvents.matchCount({ display }));
  }

  /**
   * Compute the local highlighted match index for a specific item.
   * Returns the local index within the item, or null if the current match is not in this item.
   */
  private getHighlightedMatchIndex(itemId: string): number | null {
    if (!this.state || this.state.searchIndex < 0) return null;

    const globalIndex = this.state.searchIndex;
    let cumulativeIndex = 0;

    for (const item of this.items) {
      const count = this.matchCounts.get(item.id) ?? 0;
      if (item.id === itemId) {
        // Check if the global index falls within this item's range
        if (
          globalIndex >= cumulativeIndex &&
          globalIndex < cumulativeIndex + count
        ) {
          return globalIndex - cumulativeIndex;
        }
        return null;
      }
      cumulativeIndex += count;
    }
    return null;
  }

  private async applySearchToItems(
    term: string,
    version: number,
  ): Promise<void> {
    const historyItems = this.getHistoryItems();
    const counts = await Promise.all(
      historyItems.map(
        (item) => item.applySearch?.(term) ?? Promise.resolve(0),
      ),
    );
    if (version !== this.searchVersion) {
      return;
    }

    // Store match counts per item for computing highlighted indices
    const newMatchCounts = new Map<string, number>();
    this.items.forEach((item, index) => {
      newMatchCounts.set(item.id, counts[index] ?? 0);
    });
    this.matchCounts = newMatchCounts;

    const total = counts.reduce((sum, count) => sum + count, 0);
    this.state?.setTotalMatches(total);
    if (total > 0) {
      this.state?.setSearchIndex(0);
      this.updateMatchCount();
      // Trigger re-render to update highlightedMatchIndex props
      this.requestUpdate();
    } else {
      this.state?.setSearchIndex(-1);
      this.updateMatchCount();
    }
  }

  private clearItemMarks(): void {
    const items = this.getHistoryItems();
    void Promise.all(
      items.map((item) => item.applySearch?.('') ?? Promise.resolve(0)),
    );
  }

  private getHistoryItems(): Array<
    HTMLElement & {
      applySearch: (term: string) => Promise<number>;
      getMarks: () => HTMLElement[];
    }
  > {
    // @queryAll returns NodeList, not Array - convert for .map() support
    return [...(this.historyItemElements ?? [])];
  }

  private handleToggle(
    event: CustomEvent<{ historyId: string; open: boolean }>,
  ): void {
    if (!this.state) return;
    // Ignore toggle when searching (items are auto-expanded during search)
    if (this.searchTerm) {
      return;
    }
    this.state.toggleStates.set(event.detail.historyId, event.detail.open);
  }

  private handleClear(): void {
    this.dispatchEvent(HistoryViewEvents.clearHistory());
  }

  override render(): TemplateResult {
    if (!this.items.length) {
      return html`<div class="empty-state">No history items found</div>`;
    }

    const hasMatches = (this.state?.totalMatches ?? 0) > 0;
    const forceOpen = Boolean(this.searchTerm && hasMatches);

    return html`
      <div class="clear-container">
        <vscode-toolbar-button
          class="button-clear"
          icon="clear-all"
          label="Clear All History"
          title="Clear all history"
          @click=${this.handleClear}
        ></vscode-toolbar-button>
      </div>
      <div class="history-container">
        ${repeat(
          this.items,
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
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'history-list': HistoryList;
  }
}
