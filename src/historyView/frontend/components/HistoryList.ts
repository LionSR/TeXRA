// Third-party imports
import { LitElement, html, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, queryAll, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';
import { historyViewStyles } from '../styles';

// Local imports - history view components
import './HistoryItem';

// Local imports - history view events
import { HistoryViewEvents } from '../events';

// Local imports - history view state
import type { HistoryViewState } from '../state';

// Local imports - shared schemas
import type { HistoryItem as HistoryItemData } from '@shared/schemas';

/** Search navigation action (reactive trigger from parent) */
export type SearchAction = 'next' | 'prev' | null;

@customElement('history-list')
export class HistoryList extends LitElement {
  static styles = [designTokens, commonViewStyles, historyViewStyles];

  @property({ attribute: false }) items: HistoryItemData[] = [];
  @property({ attribute: false }) state?: HistoryViewState;

  // === Reactive search properties (Lit-native Phase 9) ===
  /** Search term from parent - triggers search when changed */
  @property({ type: String }) searchTerm = '';
  /** Navigation action trigger - 'next' | 'prev' | null */
  @property({ type: String }) searchAction: SearchAction = null;
  /** Trigger to clear search state (set true to clear, resets to false) */
  @property({ type: Boolean }) clearSearchTrigger = false;

  @state() private hasSearchMatches = false;

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
    if (changedProperties.has('clearSearchTrigger') && this.clearSearchTrigger) {
      this.performClearSearch();
      // Dispatch event to reset the trigger
      this.dispatchEvent(
        new CustomEvent('search-clear-complete', { bubbles: true, composed: true }),
      );
    }

    // Handle searchTerm changes - apply search
    if (changedProperties.has('searchTerm')) {
      this.performSearch(this.searchTerm);
    }

    // Handle searchAction - navigate to next/prev match
    if (changedProperties.has('searchAction') && this.searchAction) {
      if (this.searchAction === 'next') {
        this.performNavigateNext();
      } else if (this.searchAction === 'prev') {
        this.performNavigatePrev();
      }
      // Dispatch event to reset the action
      this.dispatchEvent(
        new CustomEvent('search-navigate-complete', { bubbles: true, composed: true }),
      );
    }
  }

  protected updated(changedProps: Map<string, unknown>): void {
    // Re-apply search when items change (e.g., new history loaded)
    if (changedProps.has('items') && this.searchTerm) {
      void this.applySearchToItems(this.searchTerm);
    }
  }

  // === Internal search operations (called from willUpdate) ===

  private performClearSearch(): void {
    this.hasSearchMatches = false;
    this.state?.setSearchIndex(-1);
    this.state?.setTotalMatches(0);
    this.clearItemMarks();
    this.updateMatchCount();
  }

  private performSearch(term: string): void {
    if (!term) {
      this.hasSearchMatches = false;
      this.state?.setSearchIndex(-1);
      this.state?.setTotalMatches(0);
      this.clearItemMarks();
      this.updateMatchCount();
      return;
    }

    this.hasSearchMatches = true;
    void this.applySearchToItems(term);
  }

  private performNavigateNext(): void {
    if (!this.state || this.state.totalMatches === 0) return;
    const nextIndex = (this.state.searchIndex + 1) % this.state.totalMatches;
    this.state.setSearchIndex(nextIndex);
    this.scrollToCurrentMatch();
  }

  private performNavigatePrev(): void {
    if (!this.state || this.state.totalMatches === 0) return;
    const nextIndex =
      (this.state.searchIndex - 1 + this.state.totalMatches) %
      this.state.totalMatches;
    this.state.setSearchIndex(nextIndex);
    this.scrollToCurrentMatch();
  }

  private updateMatchCount(): void {
    if (!this.state) return;
    const total = this.state.totalMatches;
    const display = total === 0 ? '' : `${this.state.searchIndex + 1}/${total}`;
    this.dispatchEvent(HistoryViewEvents.matchCount({ display }));
  }

  private scrollToCurrentMatch(): void {
    if (!this.state || this.state.totalMatches === 0) return;
    const marks = this.getAllMarks();
    marks.forEach((mark) => mark.classList.remove('current-match'));
    if (marks.length > this.state.searchIndex) {
      const active = marks[this.state.searchIndex];
      active.classList.add('current-match');
      active.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.updateMatchCount();
    }
  }

  private async applySearchToItems(term: string): Promise<void> {
    const items = this.getHistoryItems();
    const counts = await Promise.all(
      items.map((item) => item.applySearch?.(term) ?? Promise.resolve(0)),
    );
    const total = counts.reduce((sum, count) => sum + count, 0);
    this.hasSearchMatches = total > 0;
    this.state?.setTotalMatches(total);
    if (total > 0) {
      this.state?.setSearchIndex(0);
      this.scrollToCurrentMatch();
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
    return this.historyItemElements ?? [];
  }

  private getAllMarks(): HTMLElement[] {
    return this.getHistoryItems().flatMap((item) => item.getMarks?.() ?? []);
  }

  private handleToggle = (
    event: CustomEvent<{ historyId: string; open: boolean }>,
  ): void => {
    if (!this.state) return;
    // Ignore toggle when searching (items are auto-expanded during search)
    if (this.searchTerm) {
      return;
    }
    this.state.toggleStates.set(event.detail.historyId, event.detail.open);
  };

  private handleClear = (): void => {
    this.dispatchEvent(HistoryViewEvents.clearHistory());
  };

  render(): TemplateResult {
    if (!this.items.length) {
      return html`<div class="empty-state">No history items found</div>`;
    }

    return html`
      <div class="clear-container">
        <vscode-button class="button-clear" @click=${this.handleClear}
          >Clear All History</vscode-button
        >
      </div>
      <div class="history-container">
        ${repeat(
          this.items,
          (item) => item.id,
          (item) => html`
            <history-item
              .item=${item}
              .open=${this.searchTerm && this.hasSearchMatches
                ? true
                : Boolean(this.state?.toggleStates.get(item.id))}
              @history-toggle=${this.handleToggle}
            ></history-item>
          `,
        )}
      </div>
    `;
  }
}
