/**
 * SearchBar component - search input with navigation controls.
 * Debounces input and dispatches search events to parent.
 */

// Third-party imports
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';

// Local imports - shared styles
import { designTokens, codiconStyles } from '@shared/styles';
import { historyViewStyles } from '../styles';

// Local imports - history view events
import { HistoryViewEvents } from '../events';

@customElement('history-search-bar')
export class SearchBar extends LitElement {
  static override styles = [designTokens, codiconStyles, historyViewStyles];

  @property({ type: String }) matchCount = '';
  @property({ type: String }) searchTerm = '';

  private searchTimeoutId: ReturnType<typeof setTimeout> | null = null;

  override disconnectedCallback(): void {
    if (this.searchTimeoutId) {
      clearTimeout(this.searchTimeoutId);
      this.searchTimeoutId = null;
    }
    super.disconnectedCallback();
  }

  private handleInput(event: Event): void {
    const target = event.target as HTMLInputElement | null;
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
        <vscode-toolbar-container class="search-controls">
          <vscode-toolbar-button
            class="search-nav-btn"
            icon="chevron-up"
            label="Previous match"
            title="Previous match"
            @click=${this.handlePrev}
          ></vscode-toolbar-button>
          <vscode-toolbar-button
            class="search-nav-btn"
            icon="chevron-down"
            label="Next match"
            title="Next match"
            @click=${this.handleNext}
          ></vscode-toolbar-button>
          <span class="match-count">${this.matchCount}</span>
        </vscode-toolbar-container>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'history-search-bar': SearchBar;
  }
}
