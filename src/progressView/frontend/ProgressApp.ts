// Third-party imports
import { html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { createRef, ref } from 'lit/directives/ref.js';

// Local imports - shared webview
import { BaseWebviewApp } from '@shared/BaseWebviewApp';

// Local imports - webview commands
import { WebviewStateManager } from '@shared/state';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view frontend
import {
  createInitialState,
  getEffectiveRunId,
  getStreamState,
  isToolUseState,
  type ProgressState,
  type StreamFilter,
  type StreamSort,
  type StreamState,
} from './store';

/** Persisted preferences for the progress view. */
interface ProgressViewPreferences extends Record<string, unknown> {
  streamFilter: StreamFilter;
  streamSort: StreamSort;
}

// Local imports - event handlers
import {
  handleDeleteAll,
  handleFileAction,
  handleFilterChange,
  handleFollowUpChange,
  handleFollowUpClear,
  handleFollowUpPolish,
  handleFollowUpSend,
  handleFollowupModeChange,
  handleFollowupRequestOptions,
  handleFollowupRun,
  handleFollowupSetup,
  handlePromptAction,
  handleRunSelected,
  handleSortChange,
  handleStreamDelete,
  handleStreamSwitch,
  handleToolbarCommand,
  type FrontendEventHandlerContext,
} from './eventHandlers';
import { MESSAGE_HANDLERS } from './messageHandlerRegistry';
import { getFilteredStreams } from './stateUtils';
import type { MessageHandlerContext } from './messageHandlers';
import type { StreamTabId, StreamTabInfo } from '@shared/schemas';

// Local imports - progress view components
import './components/StreamTabs';
import './components/ToolUseStreamContent';
import './components/WorkflowStreamContent';
import './components/UserMessage';
import './components/StatisticsPanel';
import './components/LatexdiffResults';
import './components/ContextManagement';

// Local imports - progress view modules
import type { FollowUpInput } from './components/FollowUpInput';
import type { LogList } from './components/LogList';
import type { PromptState } from './components/PromptOverlay';
import type { ToolUseStreamContent } from './components/ToolUseStreamContent';
import type { WorkflowStreamContent } from './components/WorkflowStreamContent';

@customElement('progress-app')
export class ProgressApp extends BaseWebviewApp {
  @state() private appState: ProgressState;
  @state() private prompts: PromptState[] = [];

  // Container refs for accessing child component methods (LogList, FollowUpInput)
  private toolUseContentRef = createRef<ToolUseStreamContent>();
  private workflowContentRef = createRef<WorkflowStreamContent>();
  // Fallback ref for when no stream is active (empty task-group-list)
  private fallbackLogListRef = createRef<LogList>();

  private prefsManager = new WebviewStateManager<ProgressViewPreferences>({
    streamFilter: 'all',
    streamSort: 'time',
  });

  constructor() {
    super();
    // Restore persisted preferences
    const prefs = this.prefsManager.getState();
    this.appState = {
      ...createInitialState(),
      streamFilter: prefs.streamFilter,
      streamSort: prefs.streamSort,
    };
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  protected override get readyCommand(): string | null {
    return PROGRESS_VIEW_COMMANDS.WEBVIEW_READY;
  }

  render(): TemplateResult {
    return html`
      <div class="main-container">
        <vscode-split-layout initial-handle-position="80%">
          <div slot="start" class="content-area">
            ${this.renderStreamContent()}
          </div>

          <stream-tabs
            slot="end"
            .streams=${getFilteredStreams(this.appState)}
            .activeStreamId=${this.appState.activeStreamId}
            .filter=${this.appState.streamFilter}
            .sort=${this.appState.streamSort}
            @stream-switch=${this.onStreamSwitch}
            @stream-delete=${this.onStreamDelete}
            @filter-change=${this.onFilterChange}
            @sort-change=${this.onSortChange}
            @delete-all=${this.onDeleteAll}
          ></stream-tabs>
        </vscode-split-layout>
      </div>
    `;
  }

  /**
   * Render stream content based on stream type.
   * Single branch point - delegates to typed container components.
   */
  private renderStreamContent(): TemplateResult {
    const activeStream = this.getActiveStreamInfo();
    if (!activeStream) {
      // No active stream - show empty task-group-list for global logs
      return html`<task-group-list
        ${ref(this.fallbackLogListRef)}
      ></task-group-list>`;
    }

    const streamState = getStreamState(this.appState, activeStream.name);

    // Single branch point: delegate to typed container component
    if (isToolUseState(streamState)) {
      return html`
        <tool-use-stream-content
          ${ref(this.toolUseContentRef)}
          .state=${streamState}
          .streamInfo=${activeStream}
          .prompts=${this.prompts}
          @toolbar-command=${this.onToolbarCommand}
          @prompt-action=${this.onPromptAction}
          @followup-change=${this.onFollowUpChange}
          @followup-send=${this.onFollowUpSend}
          @followup-polish=${this.onFollowUpPolish}
          @followup-clear=${this.onFollowUpClear}
        ></tool-use-stream-content>
      `;
    }

    // Workflow stream (default for non-tool-use)
    const runId = getEffectiveRunId(streamState);
    return html`
      <workflow-stream-content
        ${ref(this.workflowContentRef)}
        .state=${streamState}
        .streamInfo=${activeStream}
        .runId=${runId}
        .followupOptions=${this.appState.followupOptions}
        @toolbar-command=${this.onToolbarCommand}
        @run-selected=${this.onRunSelected}
        @file-action=${this.onFileAction}
        @followup-request-options=${this.onFollowupRequestOptions}
        @followup-mode-change=${this.onFollowupModeChange}
        @followup-setup=${this.onFollowupSetup}
        @followup-run=${this.onFollowupRun}
      ></workflow-stream-content>
    `;
  }

  protected handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    if (!('command' in raw) || typeof raw.command !== 'string') return;
    const command = raw.command;

    // Look up and invoke the appropriate message handler
    const handler = MESSAGE_HANDLERS[command];
    if (handler) {
      handler(raw, this.createMessageHandlerContext());
    }
  }

  private getActiveStreamInfo(): StreamTabInfo | null {
    if (!this.appState.activeStreamId) return null;
    // Search in filtered streams to respect current filter
    // This ensures we don't show content for streams hidden by filter
    const filteredStreams = getFilteredStreams(this.appState);
    return (
      filteredStreams.find(
        (stream) => stream.name === this.appState.activeStreamId,
      ) ?? null
    );
  }

  private setStreamState(
    streamId: StreamTabId,
    updater: (prev: StreamState) => StreamState,
  ): void {
    const nextStates = new Map(this.appState.streamStates);
    const current = getStreamState(this.appState, streamId);
    nextStates.set(streamId, updater(current));
    this.appState = { ...this.appState, streamStates: nextStates };
  }

  private createEventHandlerContext(): FrontendEventHandlerContext {
    return {
      getState: () => this.appState,
      setState: (updater) => {
        this.appState = updater(this.appState);
      },
      setStreamState: (streamId, updater) =>
        this.setStreamState(streamId, updater),
      getLogListRef: () => this.getLogListRef(),
      getFollowUpRef: () => this.getFollowUpRef(),
      savePrefs: (prefs) => this.prefsManager.update(prefs),
    };
  }

  /**
   * Get LogList ref from the active container component.
   * Falls back to fallback ref when no stream is active.
   */
  private getLogListRef(): LogList | undefined {
    return (
      this.toolUseContentRef.value?.getLogListRef() ??
      this.workflowContentRef.value?.getLogListRef() ??
      this.fallbackLogListRef.value
    );
  }

  /**
   * Get FollowUpInput ref from the tool-use container.
   * Returns undefined for workflow streams (they don't have follow-up input).
   */
  private getFollowUpRef(): FollowUpInput | undefined {
    return this.toolUseContentRef.value?.getFollowUpRef();
  }

  private createMessageHandlerContext(): MessageHandlerContext {
    return {
      ...this.createEventHandlerContext(),
      getPrompts: () => this.prompts,
      setPrompts: (prompts) => {
        this.prompts = prompts;
      },
    };
  }

  // Event handler wrappers - delegate to extracted handlers
  private onStreamSwitch = (e: CustomEvent): void => handleStreamSwitch(e);
  private onStreamDelete = (e: CustomEvent): void => handleStreamDelete(e);
  private onFilterChange = (e: CustomEvent): void =>
    handleFilterChange(e, this.createEventHandlerContext());
  private onSortChange = (e: CustomEvent): void =>
    handleSortChange(e, this.createEventHandlerContext());
  private onDeleteAll = (): void => handleDeleteAll();
  private onToolbarCommand = (e: CustomEvent): void =>
    handleToolbarCommand(e, this.createEventHandlerContext());
  private onRunSelected = (e: CustomEvent): void =>
    handleRunSelected(e, this.createEventHandlerContext());
  private onFileAction = (e: CustomEvent): void => handleFileAction(e);
  private onFollowUpChange = (e: CustomEvent): void =>
    handleFollowUpChange(e, this.createEventHandlerContext());
  private onFollowUpSend = (): void =>
    handleFollowUpSend(this.createEventHandlerContext());
  private onFollowUpPolish = (): void =>
    handleFollowUpPolish(this.createEventHandlerContext());
  private onFollowUpClear = (): void =>
    handleFollowUpClear(this.createEventHandlerContext());
  private onFollowupRequestOptions = (): void =>
    handleFollowupRequestOptions(this.createEventHandlerContext());
  private onFollowupModeChange = (e: CustomEvent): void =>
    handleFollowupModeChange(e, this.createEventHandlerContext());
  private onFollowupSetup = (e: CustomEvent): void =>
    handleFollowupSetup(e, this.createEventHandlerContext());
  private onFollowupRun = (e: CustomEvent): void =>
    handleFollowupRun(e, this.createEventHandlerContext());
  private onPromptAction = (e: CustomEvent): void => handlePromptAction(e);
}
