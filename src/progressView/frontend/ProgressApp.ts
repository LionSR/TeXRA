// Third-party imports
import { html, css, type TemplateResult } from 'lit';
import { provide } from '@lit/context';
import { customElement, state } from 'lit/decorators.js';
import { createRef, ref } from 'lit/directives/ref.js';

import { z } from 'zod';

// Local imports - shared webview
import { BaseWebviewApp } from '@shared/BaseWebviewApp';
import { vscode } from '@shared/vscode';
import { PersistedState, createWebviewStorage } from '@shared/state';

// Local imports - shared schemas
import {
  AgentCategoryFilterSchema,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';
import { getEffectiveRunId } from '@shared/streams/runSelection';
import { StreamSortSchema } from '@shared/streams/streamSort';

// Local imports - webview commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view frontend
import {
  createInitialState,
  EMPTY_STREAM_LOGS,
  getStreamState,
  isToolUseState,
  type ProgressState,
  type StreamLogs,
  type StreamState,
} from './store';
import { getFilteredStreams } from './stateUtils';

/** Schema for persisted preferences. */
const ProgressViewPrefsSchema = z.object({
  streamFilter: AgentCategoryFilterSchema.catch('all'),
  streamSort: StreamSortSchema.catch('time'),
});

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
  handlePermissionAction,
  handleRunSelected,
  handleSortChange,
  handleStreamDelete,
  handleStreamSwitch,
  handleToolbarCommand,
  sendFollowupCommand,
} from './eventHandlers';
import { dispatchMessage } from './messageDispatcher';

// Local imports - progress view contexts
import {
  EMPTY_LOG_CONTEXT,
  EMPTY_STREAM_CONTEXT,
  permissionsContext,
  streamLogContext,
  streamStateContext,
  type StreamContextValue,
  type StreamLogContextValue,
} from './contexts/streamContexts';
import type { FrontendEventHandlerContext } from './eventHandlers';

// Local imports - progress view message handlers
import type { MessageHandlerContext } from './messageDispatcher';

// Local imports - progress view components
import './components/StreamTabs';
import './components/ToolUseStreamContent';
import './components/WorkflowStreamContent';
import './components/UserMessage';
import './components/StatisticsPanel';
import './components/LatexdiffResults';
import './components/ContextManagement';

// Local imports - progress view component types
import type { FollowUpInput } from './components/FollowUpInput';
import type { PermissionState } from './components/PermissionCard';
import type { ToolUseStreamContent } from './components/ToolUseStreamContent';

@customElement('progress-app')
export class ProgressApp extends BaseWebviewApp {
  static override styles = css`
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
      min-width: 0;
    }

    .main-container {
      display: flex;
      flex: 1;
      height: 100%;
      overflow: hidden;
    }

    vscode-split-layout {
      display: flex;
      width: 100%;
      height: 100vh;
    }

    .content-area {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }

    /* Stream content containers - pass-through for layout */
    tool-use-stream-content,
    workflow-stream-content {
      display: contents;
    }
  `;

  @state() private appState: ProgressState;
  @state() private permissions: PermissionState[] = [];

  @provide({ context: streamStateContext })
  @state()
  private streamContextValue: StreamContextValue = EMPTY_STREAM_CONTEXT;

  @provide({ context: streamLogContext })
  @state()
  private streamLogContextValue: StreamLogContextValue = EMPTY_LOG_CONTEXT;

  @provide({ context: permissionsContext })
  @state()
  private permissionsContextValue: PermissionState[] = [];

  // Container ref for accessing child component methods (FollowUpInput)
  private toolUseContentRef = createRef<ToolUseStreamContent>();

  /**
   * Memoized filtered+sorted stream list, recomputed once per willUpdate()
   * cycle. Shared between render() and updateStreamContext() to avoid
   * redundant sort/filter on every call.
   */
  private cachedFilteredStreams: StreamTabInfo[] = [];

  /**
   * Name→StreamTabInfo index built from cachedFilteredStreams.
   * Provides O(1) lookups in updateContexts instead of O(n) find().
   */
  private cachedStreamIndex = new Map<string, StreamTabInfo>();

  private prefsManager = new PersistedState(
    createWebviewStorage(vscode),
    'progressViewPrefs',
    ProgressViewPrefsSchema,
  );

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

  protected override get readyCommand(): string | null {
    return PROGRESS_VIEW_COMMANDS.WEBVIEW_READY;
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (!changed.has('appState') && !changed.has('permissions')) return;

    const prevAppState = changed.get('appState') as ProgressState | undefined;

    if (changed.has('appState') && prevAppState) {
      const structuralChange =
        prevAppState.streams !== this.appState.streams ||
        prevAppState.streamFilter !== this.appState.streamFilter ||
        prevAppState.streamSort !== this.appState.streamSort;

      // Time sort reads lastTimestamp from streamStates, so re-sort when
      // streamStates changes too — but only for time sort.  Agent/inputFile
      // sorts depend only on static StreamTabInfo fields.
      const timeOrderMayChange =
        !structuralChange &&
        this.appState.streamSort === 'time' &&
        prevAppState.streamStates !== this.appState.streamStates;

      if (structuralChange || timeOrderMayChange) {
        this.recomputeFilteredStreams(timeOrderMayChange);
      }
    } else if (changed.has('appState')) {
      // First render or no previous state — unconditional sort.
      this.recomputeFilteredStreams(false);
    }

    this.updateContexts();
  }

  /**
   * Re-sort and filter the stream list.
   *
   * When `checkStability` is true (status-only update with time sort), we
   * compare the resulting order with the cached list.  If the order didn't
   * change, we keep the old array reference so downstream components
   * (StreamTabs repeat()) skip re-evaluation.
   */
  private recomputeFilteredStreams(checkStability: boolean): void {
    const next = getFilteredStreams(this.appState);
    if (checkStability && this.isSameOrder(this.cachedFilteredStreams, next)) {
      return; // Order unchanged — keep old reference.
    }
    this.cachedFilteredStreams = next;
    this.cachedStreamIndex = new Map(next.map((s) => [s.name, s]));
  }

  /** O(n) name-sequence comparison — cheap relative to sort. */
  private isSameOrder(a: StreamTabInfo[], b: StreamTabInfo[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].name !== b[i].name) return false;
    }
    return true;
  }

  render(): TemplateResult {
    return html`
      <div class="main-container">
        <vscode-split-layout initial-handle-position="80%">
          <div
            slot="start"
            class="content-area"
            @stream-switch=${this.onStreamSwitch}
          >
            ${this.renderStreamContent()}
          </div>

          <stream-tabs
            slot="end"
            .streams=${this.cachedFilteredStreams}
            .streamStates=${this.appState.streamStates}
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
    const { streamInfo, streamState, isToolUse } = this.streamContextValue;
    if (!streamInfo || !streamState) {
      // No active stream - show empty log-list
      return html`<log-list></log-list>`;
    }

    // Single branch point: delegate to typed container component
    if (isToolUse) {
      return html`
        <tool-use-stream-content
          ${ref(this.toolUseContentRef)}
          @toolbar-command=${this.onToolbarCommand}
          @permission-action=${this.onPermissionAction}
          @followup-change=${this.onFollowUpChange}
          @followup-send=${this.onFollowUpSend}
          @followup-polish=${this.onFollowUpPolish}
          @followup-clear=${this.onFollowUpClear}
          @followup-focus-complete=${this.onFollowUpFocusComplete}
        ></tool-use-stream-content>
      `;
    }

    // Workflow stream (default for non-tool-use)
    return html`
      <workflow-stream-content
        @toolbar-command=${this.onToolbarCommand}
        @permission-action=${this.onPermissionAction}
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
    // Schema-driven dispatch - parses once with discriminated union,
    // then routes to typed handler
    dispatchMessage(raw, this.createMessageHandlerContext());
  }

  /**
   * Update stream contexts from current appState.
   *
   * Logs and meta are stored in separate Maps (streamLogs vs streamStates),
   * so log-only updates (~10Hz during streaming) don't change the streamStates
   * ref — the meta context assignment is naturally skipped via simple `!==`.
   * No field-by-field comparison needed.
   */
  private updateContexts(): void {
    const hasStreams = this.cachedFilteredStreams.length > 0;
    // O(1) lookup via index Map instead of O(n) find() on cachedFilteredStreams
    const activeStreamInfo = this.appState.activeStreamId
      ? (this.cachedStreamIndex.get(this.appState.activeStreamId) ?? null)
      : null;

    if (!activeStreamInfo) {
      this.streamLogContextValue = { ...EMPTY_LOG_CONTEXT, hasStreams };
      this.streamContextValue = { ...EMPTY_STREAM_CONTEXT, hasStreams };
      this.permissionsContextValue = this.permissions;
      return;
    }

    const streamState = getStreamState(
      this.appState,
      activeStreamInfo.name,
      activeStreamInfo.agentCategory,
    );
    const streamLogs =
      this.appState.streamLogs.get(activeStreamInfo.name) ?? EMPTY_STREAM_LOGS;
    const isToolUse = isToolUseState(streamState);
    const runId = getEffectiveRunId(streamState, { mode: 'fallback' });

    // Log context: rebuild when logs, taskGroups, or related fields changed.
    const prevLog = this.streamLogContextValue;
    if (
      prevLog.logs !== streamLogs.logs ||
      prevLog.taskGroups !== streamState.taskGroups ||
      prevLog.runId !== runId ||
      prevLog.isToolUse !== isToolUse ||
      prevLog.hasStreams !== hasStreams ||
      prevLog.streamName !== activeStreamInfo.name
    ) {
      this.streamLogContextValue = {
        logs: streamLogs.logs,
        taskGroups: streamState.taskGroups,
        runId,
        isToolUse,
        hasStreams,
        streamName: activeStreamInfo.name,
      };
    }

    // Meta context: simple ref check on streamState.
    // Since log-only updates (APPEND_LOG, UPDATE_LOG) only touch streamLogs Map,
    // the streamStates entry ref stays the same → this assignment is skipped.
    const followupOptions =
      this.appState.followupOptionsByStream.get(activeStreamInfo.name) ?? null;
    const prevCtx = this.streamContextValue;
    if (
      prevCtx.streamInfo !== activeStreamInfo ||
      prevCtx.streamState !== streamState ||
      prevCtx.runId !== runId ||
      prevCtx.followupOptions !== followupOptions ||
      prevCtx.isToolUse !== isToolUse ||
      prevCtx.hasStreams !== hasStreams
    ) {
      this.streamContextValue = {
        streamInfo: activeStreamInfo,
        streamState,
        runId,
        followupOptions,
        isToolUse,
        hasStreams,
      };
    }
    this.permissionsContextValue = this.permissions;
  }

  private setStreamState(
    streamId: StreamTabId,
    updater: (prev: StreamState) => StreamState,
  ): void {
    // Fast path: stream already has state (common during streaming).
    // Only fall back to index lookup when creating default state for new streams.
    let current = this.appState.streamStates.get(streamId);
    if (!current) {
      // Use cachedStreamIndex for O(1) lookup instead of O(n) streams.find()
      const streamInfo =
        this.cachedStreamIndex.get(streamId) ??
        this.appState.streams.find((stream) => stream.name === streamId);
      // Skip unknown streams - they'll receive full state via UPDATE_LOGS after initialization
      if (!streamInfo) return;
      current = getStreamState(
        this.appState,
        streamId,
        streamInfo.agentCategory,
      );
    }
    const updated = updater(current);
    // Skip no-op updates: avoid Map copy + appState spread + willUpdate cycle
    if (updated === current) return;
    const nextStates = new Map(this.appState.streamStates);
    nextStates.set(streamId, updated);
    this.appState = { ...this.appState, streamStates: nextStates };
  }

  private setStreamLogs(
    streamId: StreamTabId,
    updater: (prev: StreamLogs) => StreamLogs,
  ): void {
    // Skip unknown streams — prevents orphan streamLogs entries that survive
    // updateStreamInfo cleanup (which only iterates streamStates keys)
    if (!this.appState.streamStates.has(streamId)) return;
    const current = this.appState.streamLogs.get(streamId) ?? EMPTY_STREAM_LOGS;
    const updated = updater(current);
    if (updated === current) return;
    const nextLogs = new Map(this.appState.streamLogs);
    nextLogs.set(streamId, updated);
    this.appState = { ...this.appState, streamLogs: nextLogs };
  }

  /**
   * Get the event handler context.
   * Always returns fresh context - closures capture current state via getters.
   */
  private getEventHandlerContext(): FrontendEventHandlerContext {
    return {
      getState: () => this.appState,
      setState: (updater) => {
        this.appState = updater(this.appState);
      },
      setStreamState: (streamId, updater) =>
        this.setStreamState(streamId, updater),
      setStreamLogs: (streamId, updater) =>
        this.setStreamLogs(streamId, updater),
      getFollowUpRef: () => this.toolUseContentRef.value?.getFollowUpRef(),
      savePrefs: (prefs) => this.prefsManager.update(prefs),
    };
  }

  private createMessageHandlerContext(): MessageHandlerContext {
    return {
      ...this.getEventHandlerContext(),
      getPermissions: () => this.permissions,
      setPermissions: (permissions) => {
        this.permissions = permissions;
      },
    };
  }

  // Event handler wrappers - delegate to extracted handlers
  private onStreamSwitch = (e: CustomEvent): void => handleStreamSwitch(e);
  private onStreamDelete = (e: CustomEvent): void => handleStreamDelete(e);
  private onDeleteAll = (): void => handleDeleteAll();
  private onFileAction = (e: CustomEvent): void => handleFileAction(e);
  private onPermissionAction = (e: CustomEvent): void =>
    handlePermissionAction(e);

  // Event handlers requiring context
  private onFilterChange = (e: CustomEvent): void =>
    handleFilterChange(e, this.getEventHandlerContext());

  private onSortChange = (e: CustomEvent): void =>
    handleSortChange(e, this.getEventHandlerContext());

  private onToolbarCommand = (e: CustomEvent): void =>
    handleToolbarCommand(e, this.getEventHandlerContext());

  private onRunSelected = (e: CustomEvent): void =>
    handleRunSelected(e, this.getEventHandlerContext());

  private onFollowUpChange = (e: CustomEvent): void =>
    handleFollowUpChange(e, this.getEventHandlerContext());

  private onFollowUpSend = (): void =>
    handleFollowUpSend(this.getEventHandlerContext());

  private onFollowUpPolish = (): void =>
    handleFollowUpPolish(this.getEventHandlerContext());

  private onFollowUpClear = (): void =>
    handleFollowUpClear(this.getEventHandlerContext());

  private onFollowupRequestOptions = (): void =>
    handleFollowupRequestOptions(this.getEventHandlerContext());

  private onFollowupModeChange = (e: CustomEvent): void =>
    handleFollowupModeChange(e, this.getEventHandlerContext());

  private onFollowupSetup = (e: CustomEvent): void =>
    sendFollowupCommand(
      PROGRESS_VIEW_COMMANDS.SETUP_FOLLOWUP,
      e,
      this.getEventHandlerContext(),
    );

  private onFollowupRun = (e: CustomEvent): void =>
    sendFollowupCommand(
      PROGRESS_VIEW_COMMANDS.RUN_FOLLOWUP,
      e,
      this.getEventHandlerContext(),
    );

  /**
   * Reset focus/polish/transcription triggers after they've been consumed.
   * Part of Lit-native Phase 9e reactive property pattern.
   */
  private onFollowUpFocusComplete(): void {
    const streamId = this.appState.activeStreamId;
    if (!streamId) return;

    this.setStreamState(streamId, (prev) => {
      if (!isToolUseState(prev)) return prev;
      return {
        ...prev,
        ui: {
          ...prev.ui,
          shouldFocusFollowUp: false,
          polishedText: null,
          transcribedText: null,
        },
      };
    });
  }
}
