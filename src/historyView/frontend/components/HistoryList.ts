// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
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

@customElement('history-list')
export class HistoryList extends LitElement {
  static styles = [designTokens, commonViewStyles, historyViewStyles];

  @property({ attribute: false }) items: HistoryItemData[] = [];
  @property({ attribute: false }) state?: HistoryViewState;

  private term = '';

  protected updated(changedProps: Map<string, unknown>): void {
    if (changedProps.has('items') && this.term) {
      void this.applySearchToItems(this.term);
    }
  }

  clearSearch(): void {
    this.term = '';
    this.state?.setSearchIndex(-1);
    this.state?.setTotalMatches(0);
    this.clearItemMarks();
    this.updateMatchCount();
  }

  search(term: string): void {
    this.term = term;
    if (!term) {
      this.state?.setSearchIndex(-1);
      this.state?.setTotalMatches(0);
      this.clearItemMarks();
      this.updateMatchCount();
      return;
    }

    void this.applySearchToItems(term);
  }

  navigateNext(): void {
    if (!this.state || this.state.totalMatches === 0) return;
    const nextIndex = (this.state.searchIndex + 1) % this.state.totalMatches;
    this.state.setSearchIndex(nextIndex);
    this.scrollToCurrentMatch();
  }

  navigatePrev(): void {
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
    return [...this.renderRoot.querySelectorAll('history-item')] as Array<
      HTMLElement & {
        applySearch: (term: string) => Promise<number>;
        getMarks: () => HTMLElement[];
      }
    >;
  }

  private getAllMarks(): HTMLElement[] {
    return this.getHistoryItems().flatMap((item) => item.getMarks?.() ?? []);
  }

  private handleToggle = (
    event: CustomEvent<{ historyId: string; open: boolean }>,
  ): void => {
    if (!this.state) return;
    if (this.term) {
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
              .open=${this.term
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
