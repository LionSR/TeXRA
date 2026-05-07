/**
 * SearchBar component - search input with navigation controls.
 * Debounces input and dispatches search events to parent.
 */

// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens } from '@shared/styles';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { historyViewStyles } from './styles';

// Local imports - history view events
import { HistoryViewEvents } from './events';

@customElement('history-search-bar')
export class SearchBar extends LitElement {
  static override styles = [designTokens, commonViewStyles, historyViewStyles];

  @property({ attribute: false }) searchTerm = '';
  @property({ attribute: false }) matchCount = '';
  @property({ type: Boolean, attribute: false }) canClearHistory = false;

  private searchTimeoutId: ReturnType<typeof setTimeout> | null = null;

  override disconnectedCallback(): void {
    if (this.searchTimeoutId) {
      clearTimeout(this.searchTimeoutId);
      this.searchTimeoutId = null;
    }
    super.disconnectedCallback();
  }

  private handleInput(event: Event): void {
    const target = event.currentTarget as HTMLInputElement | null;
    const term = target?.value?.trim() ?? '';
    if (this.searchTimeoutId) {
      clearTimeout(this.searchTimeoutId);
    }
    this.searchTimeoutId = setTimeout(() => {
      this.dispatchEvent(HistoryViewEvents.searchChange({ term }));
    }, 300);
  }

  private handleNext(): void {
    this.dispatchEvent(HistoryViewEvents.searchNext());
  }

  private handlePrev(): void {
    this.dispatchEvent(HistoryViewEvents.searchPrev());
  }

  private handleClearHistory(): void {
    this.dispatchEvent(HistoryViewEvents.clearHistory());
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (event.shiftKey) {
      this.handlePrev();
    } else {
      this.handleNext();
    }
  }

  override render(): TemplateResult {
    return html`
      <div class="search-container">
        <vscode-textfield
          class="search-input"
          type="search"
          placeholder="Search history items..."
          .value=${this.searchTerm}
          @input=${this.handleInput}
          @keydown=${this.handleKeydown}
        ></vscode-textfield>
        <div class="search-controls action-button-group">
          ${renderIconActionButton({
            icon: 'chevron-up',
            label: 'Previous match',
            onClick: this.handlePrev,
          })}
          ${renderIconActionButton({
            icon: 'chevron-down',
            label: 'Next match',
            onClick: this.handleNext,
          })}
          <span class="match-count">${this.matchCount}</span>
          ${this.canClearHistory
            ? renderIconActionButton({
                icon: 'trash',
                label: 'Clear history',
                title: 'Clear all history',
                action: 'clear-history',
                onClick: this.handleClearHistory,
              })
            : ''}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'history-search-bar': SearchBar;
  }
}
