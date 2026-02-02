/**
 * HistoryTab component - history management content for settings view.
 * Reuses history view components from historyView.
 */

// Third-party imports
import { LitElement, html, css, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { badgeStyles, commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared schemas
import type { HistoryItem } from '@shared/schemas';

// Local imports - settings view components
import { HistoryViewState } from '../components/history/state';
import '../components/history/SearchBar';
import '../components/history/HistoryList';
import type { SearchAction } from '../components/history/HistoryList';

@customElement('history-tab')
export class HistoryTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    ...badgeStyles,
    css`
      :host {
        display: block;
      }

      .search-container {
        display: flex;
        align-items: center;
        margin-bottom: var(--spacing-xlarge);
        gap: var(--spacing-medium);
        width: 100%;
      }

      .search-input {
        flex: 1;
        padding: var(--spacing-medium);
        font-size: var(--font-size);
      }

      .search-controls {
        display: flex;
        align-items: center;
        gap: var(--spacing-small);
      }

      .search-nav-btn {
        min-width: var(--height-button);
        height: var(--height-button);
        padding: 0;
        font-size: var(--font-size);
      }

      .match-count {
        font-size: var(--font-size-sm);
        color: var(--color-text-secondary);
        min-width: calc(var(--height-button) * 2);
        text-align: center;
      }

      .history-container {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-medium);
      }

      .clear-container {
        margin-bottom: var(--spacing-xlarge);
      }

      .button-clear {
        padding: var(--spacing-medium) var(--spacing-large);
      }

      .history-details {
        display: grid;
        grid-template-columns: 100px 1fr;
        gap: var(--spacing-small);
        margin-top: var(--spacing-medium);
      }

      .history-label {
        font-weight: bold;
        color: var(--vscode-editor-foreground);
      }

      .history-value {
        color: var(--vscode-editor-foreground);
        padding: var(--spacing-small) 0;
        word-break: break-word;
      }

      .history-item.selected {
        background-color: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
      }

      .history-item {
        margin-bottom: var(--spacing-medium);
      }

      .history-actions {
        display: flex;
        gap: var(--spacing-small);
      }

      .history-timestamp {
        font-size: var(--font-size-sm);
        margin-bottom: var(--spacing-small);
      }

      .config-section {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-small);
        background-color: var(--vscode-editor-inactiveSelectionBackground);
        padding: var(--spacing-medium);
        border-radius: var(--border-radius);
        margin: var(--spacing-medium) 0;
      }

      .config-item {
        display: flex;
        gap: var(--spacing-medium);
        align-items: baseline;
      }

      .config-key {
        font-weight: 500;
        color: var(--vscode-editorInfo-foreground);
        min-width: calc(
          var(--width-button-min) + var(--spacing-xlarge) +
            var(--spacing-xlarge)
        );
      }

      .config-value {
        color: var(--vscode-descriptionForeground);
        word-break: break-word;
      }
    `,
  ];

  @property({ attribute: false }) items: HistoryItem[] = [];
  @state() private matchCount = '';
  @state() private searchTerm = '';
  @state() private searchAction: SearchAction = null;
  @state() private clearSearchTrigger = false;

  private stateStore = new HistoryViewState();

  override connectedCallback(): void {
    super.connectedCallback();
    this.stateStore.initialize();
  }

  public clearSearch(): void {
    this.searchTerm = '';
    this.clearSearchTrigger = true;
  }

  private handleSearchChange(event: CustomEvent<{ term: string }>): void {
    this.searchTerm = event.detail.term;
  }

  private handleSearchNavigate(direction: SearchAction): void {
    this.searchAction = direction;
  }

  private handleSearchNavigateComplete(): void {
    this.searchAction = null;
  }

  private handleSearchClearComplete(): void {
    this.clearSearchTrigger = false;
  }

  private handleMatchCount(event: CustomEvent<{ display: string }>): void {
    this.matchCount = event.detail.display;
  }

  override render(): TemplateResult {
    return html`
      <history-search-bar
        .matchCount=${this.matchCount}
        .searchTerm=${this.searchTerm}
        @history-search-change=${this.handleSearchChange}
        @history-search-next=${() => this.handleSearchNavigate('next')}
        @history-search-prev=${() => this.handleSearchNavigate('prev')}
      ></history-search-bar>

      <history-list
        .items=${this.items}
        .state=${this.stateStore}
        .searchTerm=${this.searchTerm}
        .searchAction=${this.searchAction}
        .clearSearchTrigger=${this.clearSearchTrigger}
        @history-match-count=${this.handleMatchCount}
        @search-navigate-complete=${this.handleSearchNavigateComplete}
        @search-clear-complete=${this.handleSearchClearComplete}
      ></history-list>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'history-tab': HistoryTab;
  }
}
