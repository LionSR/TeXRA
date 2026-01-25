// Third-party imports
import { html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { createRef, ref } from 'lit/directives/ref.js';
import { when } from 'lit/directives/when.js';

// Local imports - shared webview
import { BaseWebviewApp } from '@shared/BaseWebviewApp';

// Local imports - shared schemas
import { AGENT_CATEGORY } from '@shared/schemas';

// Local imports - webview commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import { createThemeHandlers } from '@common/webview/themeHandlers.js';

// Local imports - progress view frontend
import {
  createInitialState,
  getEffectiveRunId,
  getStreamState,
  type ProgressState,
  type StreamFilter,
  type StreamSort,
  type StreamState,
} from './store';

// Local imports - shared state
import { WebviewStateManager } from '@shared/state';

/** Persisted preferences for the progress view. */
interface ProgressViewPreferences extends Record<string, unknown> {
  streamFilter: StreamFilter;
  streamSort: StreamSort;
}

// Local imports - shared schemas (types)
import {
  handleDeleteAll,
  handleFileAction,
  handleFilterChange,
  handleFollowUpChange,
  handleFollowUpClear,
  handleFollowUpPolish,
  handleFollowUpSend,
  handleFollowUpToggleBypass,
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
import {
  handleAddTaskGroup,
  handleAppendLog,
  handleDeleteAll as handleDeleteAllMessage,
  handleDeleteStream,
  handleFollowUpTextPolished,
  handleFollowUpTextTranscribed,
  handleRecordingError,
  handleRecordingStarted,
  handleRecordingStopped,
  handleResolveBashApproval,
  handleResolveAgentProposal,
  handleResolveRetryRequest,
  handleResolveToolEditApproval,
  handleSetFollowupOptions,
  handleShowAgentProposal,
  handleShowBashApproval,
  handleShowRetryRequest,
  handleShowToolEditApproval,
  handleUpdateContextState,
  handleUpdateFiles,
  handleUpdateInstruction,
  handleUpdateLog,
  handleUpdateLogs,
  handleUpdateMissingOutputs,
  handleUpdateQueuedFollowUps,
  handleUpdateRunUsage,
  handleUpdateStatus,
  handleUpdateStreamStatus,
  handleUpdateStreams,
  handleUpdateTaskGroup,
  handleUpdateTodos,
  handleUpdateToolEditApprovalState,
  handleUpdateUsage,
  type MessageHandlerContext,
} from './messageHandlers';
import { getFilteredStreams, getRunGroups } from './stateUtils';
import type { StreamTabId, StreamTabInfo } from '@shared/schemas';

// Local imports - progress view components
import './components/StreamTabs';
import './components/StreamHeader';
import './components/RunSelector';
import './components/InstructionPanel';
import './components/TodoList';
import './components/FileList';
import './components/UsagePanel';
import './components/FollowUpInput';
import './components/FollowupSection';
import './components/TaskGroupList';
import './components/PromptOverlay';

// Local imports - progress view modules
import type { FollowUpInput } from './components/FollowUpInput';
import type { LogList } from './components/LogList';
import type { PromptState } from './components/PromptOverlay';

/**
 * Updates the highlight.js theme stylesheet based on VS Code theme.
 */
function updateHighlightTheme(theme: string): void {
  const link = document.getElementById('hljs-theme') as HTMLLinkElement | null;
  if (!link) return;
  link.href = `https://cdn.jsdelivr.net/npm/highlight.js@11.11.1/styles/${
    theme === 'dark' ? 'github-dark' : 'github'
  }.css`;
}

@customElement('progress-app')
export class ProgressApp extends BaseWebviewApp {
  @state() private appState: ProgressState;
  @state() private prompts: PromptState[] = [];

  private logListRef = createRef<LogList>();
  private followUpRef = createRef<FollowUpInput>();
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
    const activeStream = this.getActiveStreamInfo();
    const streamState = activeStream
      ? getStreamState(this.appState, activeStream.name)
      : null;
    const runId = streamState ? getEffectiveRunId(streamState) : null;
    const isToolUse =
      activeStream?.agentCategory === AGENT_CATEGORY.TOOL_USE || false;
    const filteredPrompts = this.getFilteredPrompts(
      activeStream?.name ?? null,
      isToolUse,
    );

    return html`
      <div class="main-container">
        <vscode-split-layout initial-handle-position="80%">
          <div slot="start" class="content-area">
            ${activeStream
              ? html`
                  <stream-header
                    .stream=${activeStream}
                    .streamState=${streamState}
                    .runId=${runId}
                    .runs=${getRunGroups(streamState?.taskGroups ?? [])}
                    @toolbar-command=${this.onToolbarCommand}
                    @run-selected=${this.onRunSelected}
                  ></stream-header>

                  <instruction-panel
                    .instruction=${!isToolUse
                      ? (streamState?.runInstructions?.[runId ?? 'default'] ??
                        null)
                      : null}
                  ></instruction-panel>

                  ${when(
                    isToolUse,
                    () => html`
                      <todo-list .todos=${streamState?.todos ?? []}></todo-list>
                    `,
                  )}

                  <task-group-list ${ref(this.logListRef)}></task-group-list>

                  <usage-panel
                    .usage=${runId
                      ? (streamState?.runUsage?.[runId] ?? null)
                      : null}
                    .contextState=${streamState?.contextState ?? null}
                  ></usage-panel>

                  <file-list
                    .filesByRound=${runId
                      ? (streamState?.runFiles?.[runId] ?? {})
                      : {}}
                    .showRoundHeaders=${!isToolUse}
                    @file-action=${this.onFileAction}
                  ></file-list>

                  <follow-up-input
                    ${ref(this.followUpRef)}
                    .visible=${isToolUse}
                    .value=${streamState?.followUpText ?? ''}
                    .yoloActive=${Boolean(streamState?.toolEditBypass)}
                    .queuedMessages=${streamState?.queuedFollowUps ?? []}
                    @followup-change=${this.onFollowUpChange}
                    @followup-send=${this.onFollowUpSend}
                    @followup-polish=${this.onFollowUpPolish}
                    @followup-clear=${this.onFollowUpClear}
                    @followup-toggle-bypass=${this.onFollowUpToggleBypass}
                  ></follow-up-input>

                  <followup-section
                    .agentCategory=${activeStream.agentCategory}
                    .status=${streamState?.status ?? activeStream.status ?? ''}
                    .hasOutputFiles=${Object.values(
                      runId ? (streamState?.runFiles?.[runId] ?? {}) : {},
                    ).flat().length > 0}
                    .options=${this.appState.followupOptions}
                    .mode=${streamState?.followupMode ?? 'chat'}
                    .streamModel=${activeStream.model ?? null}
                    @followup-request-options=${this.onFollowupRequestOptions}
                    @followup-mode-change=${this.onFollowupModeChange}
                    @followup-setup=${this.onFollowupSetup}
                    @followup-run=${this.onFollowupRun}
                  ></followup-section>
                `
              : html`
                  <task-group-list ${ref(this.logListRef)}></task-group-list>
                `}
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

      <prompt-overlay
        ?hidden=${filteredPrompts.length === 0}
        .prompt=${filteredPrompts.at(0) ?? null}
        @prompt-action=${this.onPromptAction}
      ></prompt-overlay>
    `;
  }

  protected handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    if (!('command' in raw) || typeof raw.command !== 'string') return;
    const command = raw.command;

    // Handle theme commands first
    const themeHandlers = createThemeHandlers({
      commands: PROGRESS_VIEW_COMMANDS,
      onThemeChange: updateHighlightTheme,
    }) as Record<string, (message: unknown) => void>;
    const themeHandler = themeHandlers[command];
    if (themeHandler) {
      themeHandler(raw);
      return;
    }

    const ctx = this.createMessageHandlerContext();

    // Handle app-specific commands
    switch (command) {
      case PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS:
        handleUpdateStreams(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.UPDATE_LOGS:
        handleUpdateLogs(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.APPEND_LOG:
        handleAppendLog(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.UPDATE_LOG:
        handleUpdateLog(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.UPDATE_STATUS:
        handleUpdateStatus(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS:
        handleUpdateStreamStatus(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.UPDATE_FILES:
        handleUpdateFiles(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS:
        handleUpdateMissingOutputs(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.UPDATE_INSTRUCTION:
        handleUpdateInstruction(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS:
        handleUpdateQueuedFollowUps(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE:
        handleUpdateRunUsage(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.UPDATE_CONTEXT_STATE:
        handleUpdateContextState(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.ADD_TASK_GROUP:
        handleAddTaskGroup(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.UPDATE_TASK_GROUP:
        handleUpdateTaskGroup(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.UPDATE_TODOS:
        handleUpdateTodos(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.SHOW_TOOL_EDIT_APPROVAL:
        handleShowToolEditApproval(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.RESOLVE_TOOL_EDIT_APPROVAL:
        handleResolveToolEditApproval(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.UPDATE_TOOL_EDIT_APPROVAL_STATE:
        handleUpdateToolEditApprovalState(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.SHOW_BASH_APPROVAL:
        handleShowBashApproval(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.RESOLVE_BASH_APPROVAL:
        handleResolveBashApproval(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.SHOW_RETRY_REQUEST:
        handleShowRetryRequest(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.RESOLVE_RETRY_REQUEST:
        handleResolveRetryRequest(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.SHOW_AGENT_PROPOSAL:
        handleShowAgentProposal(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.RESOLVE_AGENT_PROPOSAL:
        handleResolveAgentProposal(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_POLISHED:
        handleFollowUpTextPolished(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_TRANSCRIBED:
        handleFollowUpTextTranscribed(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.RECORDING_STARTED:
        handleRecordingStarted(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.RECORDING_STOPPED:
        handleRecordingStopped(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.RECORDING_ERROR:
        handleRecordingError(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.SET_FOLLOWUP_OPTIONS:
        handleSetFollowupOptions(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.DELETE_STREAM:
        handleDeleteStream(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.DELETE_ALL:
        handleDeleteAllMessage(raw, ctx);
        break;
      case PROGRESS_VIEW_COMMANDS.UPDATE_USAGE:
        handleUpdateUsage(raw, ctx);
        break;
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

  /**
   * Filter prompts to only show those matching the active stream.
   * Prompts are only shown for tool-use agents (legacy behavior).
   * Prompts with empty streamId are shown for all streams.
   */
  private getFilteredPrompts(
    activeStreamId: string | null,
    isToolUse: boolean,
  ): PromptState[] {
    if (!isToolUse || !activeStreamId) return [];

    return this.prompts.filter(
      (prompt) =>
        !prompt.data.streamId || prompt.data.streamId === activeStreamId,
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
      getLogListRef: () => this.logListRef.value,
      getFollowUpRef: () => this.followUpRef.value,
      savePrefs: (prefs) => this.prefsManager.update(prefs),
    };
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
  private onFollowUpToggleBypass = (): void =>
    handleFollowUpToggleBypass(this.createEventHandlerContext());
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
