/** History management content for the settings view. */

import { LitElement, html, type TemplateResult, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// Local imports - shared styles
import { commonViewStyles, designTokens, historyStyles } from '@shared/styles';

// Local imports - shared schemas
import type { HistoryItem } from '@shared/schemas';
import { HistoryViewState } from '../components/history/state';

// Local imports - settings view components
import '../components/history/SearchBar';
import '../components/history/HistoryList';
import type { SearchAction } from '../components/history/HistoryList';

@customElement('history-tab')
export class HistoryTab extends LitElement {
  static override styles = [
    designTokens,
    commonViewStyles,
    ...historyStyles,
    css`
      :host {
        display: block;
      }
    `,
  ];

  @property({ attribute: false }) items: HistoryItem[] = [];
  /**
   * Settings-view commands the active host's registry declares
   * `unsupported(...)` (see StreamHeader's `unsupportedCommands` for the
   * same convention). Threaded down to `history-item` so per-item actions
   * (rerun, setup, export) hide on a host that can't act on them, instead
   * of leaving a control visible that can only produce an
   * unavailable-command toast.
   */
  @property({ attribute: false })
  unsupportedCommands: ReadonlySet<string> | null = null;
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
      <div class="tab-content-container">
        <history-search-bar
          .matchCount=${this.matchCount}
          .searchTerm=${this.searchTerm}
          .canClearHistory=${this.items.length > 0}
          @history-search-change=${this.handleSearchChange}
          @history-search-next=${() => this.handleSearchNavigate('next')}
          @history-search-prev=${() => this.handleSearchNavigate('prev')}
        ></history-search-bar>

        <history-list
          .items=${this.items}
          .unsupportedCommands=${this.unsupportedCommands}
          .state=${this.stateStore}
          .searchTerm=${this.searchTerm}
          .searchAction=${this.searchAction}
          .clearSearchTrigger=${this.clearSearchTrigger}
          @history-match-count=${this.handleMatchCount}
          @search-navigate-complete=${this.handleSearchNavigateComplete}
          @search-clear-complete=${this.handleSearchClearComplete}
        ></history-list>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'history-tab': HistoryTab;
  }
}
