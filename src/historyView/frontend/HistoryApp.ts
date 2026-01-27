/**
 * HistoryApp component - main container for the agent execution history view.
 * Manages search state and delegates to SearchBar and HistoryList components.
 */

// Third-party imports
import { html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';

// Local imports - shared webview
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { postMessage } from '@shared/vscode';

// Local imports - shared styles
import { badgeStyles, commonViewStyles, designTokens } from '@shared/styles';

// Local imports - shared schemas
import {
  HistoryClearedMessageSchema,
  UpdateHistoryMessageSchema,
  type HistoryItem,
} from '@shared/schemas';

// Local imports - webview commands
import { HISTORY_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - history view styles
import { historyViewStyles } from './styles';

// Local imports - history view components (side-effect: register)
import './components/SearchBar';
import './components/HistoryList';

// Local imports - history view state
import { HistoryViewState } from './state';

// Local imports - history view types
import type { SearchAction } from './components/HistoryList';

const HISTORY_ACTION_COMMANDS: Record<string, string> = {
  delete: HISTORY_VIEW_COMMANDS.DELETE_AGENT,
  restore: HISTORY_VIEW_COMMANDS.RESTORE_AGENT,
  rerun: HISTORY_VIEW_COMMANDS.RERUN_AGENT,
};

@customElement('history-app')
export class HistoryApp extends BaseWebviewApp {
  static override styles = [
    designTokens,
    commonViewStyles,
    ...badgeStyles,
    historyViewStyles,
  ];

  @state() private items: HistoryItem[] = [];
  @state() private matchCount = '';

  // === Reactive search state (Lit-native Phase 9) ===
  @state() private searchTerm = '';
  @state() private searchAction: SearchAction = null;
  @state() private clearSearchTrigger = false;

  private stateStore = new HistoryViewState();

  protected get readyCommand(): string | null {
    return null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.stateStore.initialize();
    postMessage(HISTORY_VIEW_COMMANDS.GET_HISTORY_DATA);
  }

  protected override handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || !('command' in raw)) {
      return;
    }

    const command = (raw as { command: string }).command;
    if (command === HISTORY_VIEW_COMMANDS.UPDATE_HISTORY) {
      const result = UpdateHistoryMessageSchema.safeParse(raw);
      if (!result.success) {
        this.logSchemaError(
          '[HistoryApp] Update history message validation failed.',
          result.error,
        );
        return;
      }
      this.items = [...result.data.historyItems].sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
      return;
    }

    if (command === HISTORY_VIEW_COMMANDS.HISTORY_CLEARED) {
      const result = HistoryClearedMessageSchema.safeParse(raw);
      if (!result.success) {
        this.logSchemaError(
          '[HistoryApp] History cleared message validation failed.',
          result.error,
        );
        return;
      }
      this.items = [];
      // Trigger search clear via reactive property (Lit-native)
      this.searchTerm = '';
      this.clearSearchTrigger = true;
    }
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

  private handleHistoryAction(
    event: CustomEvent<{ action: string; historyId: string }>,
  ): void {
    const command = HISTORY_ACTION_COMMANDS[event.detail.action];
    if (!command) return;
    postMessage(command, { historyId: event.detail.historyId });
  }

  private handleClearHistory(): void {
    postMessage(HISTORY_VIEW_COMMANDS.CLEAR_HISTORY);
  }

  override render(): TemplateResult {
    return html`
      <header class="view-header">
        <h2>Agent Execution History</h2>
      </header>

      <history-search-bar
        .matchCount=${this.matchCount}
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
        @history-action=${this.handleHistoryAction}
        @history-clear=${this.handleClearHistory}
        @history-match-count=${this.handleMatchCount}
        @search-navigate-complete=${this.handleSearchNavigateComplete}
        @search-clear-complete=${this.handleSearchClearComplete}
      ></history-list>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'history-app': HistoryApp;
  }
}
