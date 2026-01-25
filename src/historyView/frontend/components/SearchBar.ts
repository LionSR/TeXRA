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
  static styles = [designTokens, codiconStyles, historyViewStyles];

  @property({ type: String }) matchCount = '';

  private handleInput = (event: Event): void => {
    const target = event.target as HTMLInputElement | null;
    this.dispatchEvent(
      HistoryViewEvents.searchChange({ term: target?.value ?? '' }),
    );
  };

  private handleNext = (): void => {
    this.dispatchEvent(HistoryViewEvents.searchNext());
  };

  private handlePrev = (): void => {
    this.dispatchEvent(HistoryViewEvents.searchPrev());
  };

  private handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (event.shiftKey) {
      this.handlePrev();
    } else {
      this.handleNext();
    }
  };

  render(): TemplateResult {
    return html`
      <div class="search-container">
        <vscode-textfield
          class="search-input"
          type="search"
          placeholder="Search history items..."
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
