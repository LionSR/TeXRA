// Third-party imports
import { html, type TemplateResult } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';

// Local imports - shared webview
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { postMessage } from '@shared/vscode';

// Local imports - shared styles
import { designTokens, commonViewStyles } from '@shared/styles';

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

// Local imports - history view components
import './components/SearchBar';
import './components/HistoryList';

// Local imports - history view state
import { HistoryViewState } from './state';

// Local imports - history view events
import type { HistoryList } from './components/HistoryList';

@customElement('history-app')
export class HistoryApp extends BaseWebviewApp {
  static styles = [designTokens, commonViewStyles, historyViewStyles];

  @state() private items: HistoryItem[] = [];
  @state() private matchCount = '';

  private stateStore = new HistoryViewState();

  @query('history-list')
  declare private historyList: HistoryList | null;

  protected get readyCommand(): string | null {
    return null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.stateStore.initialize();
    postMessage(HISTORY_VIEW_COMMANDS.GET_HISTORY_DATA);
  }

  protected handleMessage(raw: unknown): void {
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
      this.historyList?.clearSearch();
    }
  }

  private handleSearchChange = (event: CustomEvent<{ term: string }>): void => {
    const term = event.detail.term;
    this.historyList?.search(term);
  };

  private handleSearchNext = (): void => {
    this.historyList?.navigateNext();
  };

  private handleSearchPrev = (): void => {
    this.historyList?.navigatePrev();
  };

  private handleMatchCount = (
    event: CustomEvent<{ display: string }>,
  ): void => {
    this.matchCount = event.detail.display;
  };

  private handleHistoryAction = (
    event: CustomEvent<{ action: string; historyId: string }>,
  ): void => {
    const actionMap: Record<string, string> = {
      delete: HISTORY_VIEW_COMMANDS.DELETE_AGENT,
      restore: HISTORY_VIEW_COMMANDS.RESTORE_AGENT,
      rerun: HISTORY_VIEW_COMMANDS.RERUN_AGENT,
    };
    const command = actionMap[event.detail.action];
    if (!command) return;
    postMessage(command, { historyId: event.detail.historyId });
  };

  private handleClearHistory = (): void => {
    postMessage(HISTORY_VIEW_COMMANDS.CLEAR_HISTORY);
  };

  render(): TemplateResult {
    return html`
      <header class="view-header">
        <h2>Agent Execution History</h2>
      </header>

      <history-search-bar
        .matchCount=${this.matchCount}
        @history-search-change=${this.handleSearchChange}
        @history-search-next=${this.handleSearchNext}
        @history-search-prev=${this.handleSearchPrev}
      ></history-search-bar>

      <history-list
        .items=${this.items}
        .state=${this.stateStore}
        @history-action=${this.handleHistoryAction}
        @history-clear=${this.handleClearHistory}
        @history-match-count=${this.handleMatchCount}
      ></history-list>
    `;
  }
}
