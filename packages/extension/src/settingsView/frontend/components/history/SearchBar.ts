/** Search input with navigation controls; debounces input and dispatches search events. */

import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import '@awesome.me/webawesome/dist/components/input/input.js';

// Local imports - shared webview
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@shared/hostBridge';

// Local imports - shared styles
import { commonViewStyles, designTokens, historyStyles } from '@shared/styles';
import { renderIconActionButton } from '@shared/wa/actionButtons';
import { debounce } from '@utils/core';

// Local imports - history view events
import { HistoryViewEvents } from './events';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';

const SEARCH_DEBOUNCE_MS = 300;

@customElement('history-search-bar')
export class SearchBar extends LitElement {
  static override styles = [designTokens, commonViewStyles, historyStyles];

  @property({ attribute: false }) searchTerm = '';
  @property({ attribute: false }) matchCount = '';
  @property({ type: Boolean, attribute: false }) canClearHistory = false;

  private readonly debouncedDispatchSearch = debounce((term: string) => {
    this.dispatchEvent(HistoryViewEvents.searchChange({ term }));
  }, SEARCH_DEBOUNCE_MS);

  override disconnectedCallback(): void {
    this.debouncedDispatchSearch.cancel();
    super.disconnectedCallback();
  }

  private handleInput(event: Event): void {
    const target = event.currentTarget as WaInput | null;
    const term = target?.value?.trim() ?? '';
    void this.debouncedDispatchSearch(term);
  }

  private handleNext(): void {
    this.dispatchEvent(HistoryViewEvents.searchNext());
  }

  private handlePrev(): void {
    this.dispatchEvent(HistoryViewEvents.searchPrev());
  }

  private handleClearHistory(): void {
    postMessage(SETTINGS_VIEW_COMMANDS.CLEAR_HISTORY);
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

  /** Screen-reader wording for the match count: the visible text is the
   *  compact "3/17", which announces as a bare number with no unit. */
  private get matchCountLabel(): string {
    const parts = /^(\d+)\/(\d+)$/.exec(this.matchCount.trim());
    if (!parts) return this.matchCount;
    const [, current, total] = parts;
    return `${current} of ${total} ${total === '1' ? 'match' : 'matches'}`;
  }

  override render(): TemplateResult {
    return html`
      <div class="search-container">
        <label class="visually-hidden" for="history-search">
          Search history
        </label>
        <wa-input
          id="history-search"
          class="search-input"
          type="search"
          placeholder="Search history…"
          .value=${this.searchTerm}
          @input=${this.handleInput}
          @keydown=${this.handleKeydown}
        ></wa-input>
        <div class="search-controls action-button-group">
          ${renderIconActionButton({
            id: 'history-search-prev-button',
            icon: 'chevron-up',
            label: 'Previous match',
            tooltip: 'Previous match',
            onClick: this.handlePrev,
          })}
          ${renderIconActionButton({
            id: 'history-search-next-button',
            icon: 'chevron-down',
            label: 'Next match',
            tooltip: 'Next match',
            onClick: this.handleNext,
          })}
          <span class="match-count" role="status" aria-atomic="true">
            <span aria-hidden="true">${this.matchCount}</span>
            <span class="visually-hidden">${this.matchCountLabel}</span>
          </span>
          ${
            this.canClearHistory
              ? renderIconActionButton({
                  id: 'history-search-clear-button',
                  icon: 'trash',
                  label: 'Clear all history',
                  tooltip: 'Clear all history',
                  action: 'clear-history',
                  onClick: this.handleClearHistory,
                })
              : ''
          }
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
