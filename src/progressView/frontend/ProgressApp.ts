import { create } from 'mutative';

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
  type ProgressViewOutboundMessage,
  type StreamTabId,
} from '@shared/schemas';
import { getEffectiveRunId } from '@shared/streams/runSelection';
import { StreamSortSchema } from '@shared/streams/streamSort';

// Local imports - webview commands
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view frontend
import { STREAM_STATUS } from './constants';
import {
  createInitialState,
  EMPTY_STREAM_LOGS,
  getStreamState,
  isToolUseState,
  type StreamLogs,
  type StreamState,
} from './store';
import { getFilteredStreams } from './stateUtils';
import {
  SignalWatcher,
  signal,
  Signal,
  select,
  combine,
} from '@shared/signals';

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
import type { PermissionState } from './components/PermissionCard';
import type { ToolUseStreamContent } from './components/ToolUseStreamContent';

// Cast: BaseWebviewApp is abstract, but SignalWatcher expects a concrete constructor.
// Safe because ProgressApp implements all abstract members below.
const ProgressAppBase = SignalWatcher(
  BaseWebviewApp as unknown as new (
    ...args: any[]
  ) => BaseWebviewApp<ProgressViewOutboundMessage>,
);

@customElement('progress-app')
export class ProgressApp extends ProgressAppBase {
  // Static 'styles' override lost through mixin type erasure; still works at runtime.
  static styles = css`
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

  // --- Signal-based state ---
  // Single source of truth: monolithic state wrapped in a signal.
  // Mutative's structural sharing ensures unchanged branches keep their
  // reference, so selector computeds auto-skip via Object.is().
  private appState = signal(createInitialState());
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

  // --- Selector computeds: extract fields, auto-memoized by Object.is ---
  private streamFilter$ = select(this.appState, (s) => s.streamFilter);
  private streamSort$ = select(this.appState, (s) => s.streamSort);
  private streamStates$ = select(this.appState, (s) => s.streamStates);
  private streamLogs$ = select(this.appState, (s) => s.streamLogs);
  private activeStreamId$ = select(this.appState, (s) => s.activeStreamId);
  private followupOptions$ = select(
    this.appState,
    (s) => s.followupOptionsByStream,
  );

  // --- Derived computeds: only re-evaluate when selector inputs propagate ---

  /** Filtered + sorted stream list. Re-evaluates when streams, filter, sort, or streamStates change. */
  private filteredStreams$ = combine(
    [this.appState, this.streamStates$] as const,
    (state, _states) => getFilteredStreams(state),
  );

  private filteredStreamMap$ = new Signal.Computed(
    () => new Map(this.filteredStreams$.get().map((s) => [s.name, s])),
  );

  /** Status string per stream tab. */
  private statusById$ = combine(
    [this.streamStates$, this.filteredStreams$] as const,
    (states, streams) => {
      const map = new Map<StreamTabId, string>();
      for (const stream of streams) {
        map.set(
          stream.name,
          states.get(stream.name)?.status ?? STREAM_STATUS.READY,
        );
      }
      return map;
    },
  );

  /** Last timestamp per stream tab. */
  private timestampById$ = combine(
    [this.streamStates$, this.filteredStreams$] as const,
    (states, streams) => {
      const map = new Map<StreamTabId, number | undefined>();
      for (const stream of streams) {
        map.set(stream.name, states.get(stream.name)?.lastTimestamp);
      }
      return map;
    },
  );

  /** Core active-stream derivation shared by streamContext$ and logContext$. */
  private activeStreamCore$ = new Signal.Computed(() => {
    const hasStreams = this.filteredStreams$.get().length > 0;
    const activeStreamId = this.activeStreamId$.get();
    const activeStreamInfo = activeStreamId
      ? (this.filteredStreamMap$.get().get(activeStreamId) ?? null)
      : null;

    if (!activeStreamInfo)
      return {
        hasStreams,
        activeStreamInfo: null as null,
        streamState: null as null,
        isToolUse: false,
        runId: null as string | null,
      };

    const streamState = getStreamState(
      this.appState.get(),
      activeStreamInfo.name,
      activeStreamInfo.agentCategory,
    );
    const isToolUse = isToolUseState(streamState);
    const runId = getEffectiveRunId(streamState, { mode: 'fallback' });

    return { hasStreams, activeStreamInfo, streamState, isToolUse, runId };
  });

  /** Stream context derived from active stream + state. */
  private streamContext$ = new Signal.Computed((): StreamContextValue => {
    const { hasStreams, activeStreamInfo, streamState, isToolUse, runId } =
      this.activeStreamCore$.get();
    if (!activeStreamInfo) return { ...EMPTY_STREAM_CONTEXT, hasStreams };

    const followupOptions =
      this.followupOptions$.get().get(activeStreamInfo.name) ?? null;

    return {
      streamInfo: activeStreamInfo,
      streamState,
      runId,
      followupOptions,
      isToolUse,
      hasStreams,
    };
  });

  /** Log context derived from active stream + logs. */
  private logContext$ = new Signal.Computed((): StreamLogContextValue => {
    const { hasStreams, activeStreamInfo, streamState, isToolUse, runId } =
      this.activeStreamCore$.get();
    if (!activeStreamInfo) return { ...EMPTY_LOG_CONTEXT, hasStreams };

    const streamLogs =
      this.streamLogs$.get().get(activeStreamInfo.name) ?? EMPTY_STREAM_LOGS;

    return {
      logs: streamLogs.logs,
      taskGroups: streamState!.taskGroups,
      runId,
      isToolUse,
      hasStreams,
      streamName: activeStreamInfo.name,
    };
  });

  private prefsManager = new PersistedState(
    createWebviewStorage(vscode),
    'progressViewPrefs',
    ProgressViewPrefsSchema,
  );

  constructor() {
    super();
    // Restore persisted preferences
    const prefs = this.prefsManager.getState();
    this.appState.set({
      ...createInitialState(),
      streamFilter: prefs.streamFilter,
      streamSort: prefs.streamSort,
    });
  }

  protected get readyCommand(): string | null {
    return PROGRESS_VIEW_COMMANDS.WEBVIEW_READY;
  }

  /**
   * Sync signal-computed values into @provide/@state context properties.
   * SignalWatcher triggers requestUpdate() when any read signal changes,
   * so this runs only when computed values actually propagate.
   */
  protected override willUpdate(): void {
    this.streamContextValue = this.streamContext$.get();
    this.streamLogContextValue = this.logContext$.get();
    this.permissionsContextValue = this.permissions;
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
            .streams=${this.filteredStreams$.get()}
            .activeStreamId=${this.activeStreamId$.get()}
            .filter=${this.streamFilter$.get()}
            .sort=${this.streamSort$.get()}
            .streamStatusById=${this.statusById$.get()}
            .streamLastTimestampById=${this.timestampById$.get()}
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

  protected handleMessage(message: ProgressViewOutboundMessage): void {
    dispatchMessage(message, this.createMessageHandlerContext());
  }

  private setStreamState(
    streamId: StreamTabId,
    updater: (prev: StreamState) => StreamState,
  ): void {
    const state = this.appState.get();
    // Fast path: stream already has state (common during streaming).
    // Only fall back to streamById lookup when creating default state for new streams.
    let current = state.streamStates.get(streamId);
    if (!current) {
      const streamInfo = state.streamById.get(streamId);
      // Skip unknown streams - they'll receive full state via UPDATE_LOGS after initialization
      if (!streamInfo) return;
      current = getStreamState(state, streamId, streamInfo.agentCategory);
    }
    const updated = updater(current);
    // Skip no-op updates: avoid Map copy + appState spread + willUpdate cycle
    if (updated === current) return;
    this.appState.set(
      create(state, (draft) => {
        draft.streamStates.set(streamId, updated);
      }),
    );
  }

  private setStreamLogs(
    streamId: StreamTabId,
    updater: (prev: StreamLogs) => StreamLogs,
  ): void {
    const state = this.appState.get();
    // Skip unknown streams — prevents orphan streamLogs entries that survive
    // updateStreamInfo cleanup (which only iterates streamStates keys)
    if (!state.streamStates.has(streamId)) return;
    const current = state.streamLogs.get(streamId) ?? EMPTY_STREAM_LOGS;
    const updated = updater(current);
    if (updated === current) return;
    this.appState.set(
      create(state, (draft) => {
        draft.streamLogs.set(streamId, updated);
      }),
    );
  }

  /**
   * Get the event handler context.
   * Always returns fresh context - closures capture current state via getters.
   */
  private getEventHandlerContext(): FrontendEventHandlerContext {
    return {
      getState: () => this.appState.get(),
      setState: (updater) => {
        this.appState.set(updater(this.appState.get()));
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
  private onStreamSwitch = (e: CustomEvent): void =>
    handleStreamSwitch(e, this.getEventHandlerContext());
  private onStreamDelete = (e: CustomEvent): void =>
    handleStreamDelete(e, this.getEventHandlerContext());
  private onDeleteAll = (): void => handleDeleteAll();
  private onFileAction = (e: CustomEvent): void => handleFileAction(e);
  private onPermissionAction = (e: CustomEvent): void =>
    handlePermissionAction(e, this.createMessageHandlerContext());

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
    const streamId = this.appState.get().activeStreamId;
    if (!streamId) return;

    this.setStreamState(streamId, (prev) => {
      if (!isToolUseState(prev)) return prev;
      return create(prev, (draft) => {
        draft.ui.shouldFocusFollowUp = false;
        draft.ui.polishedText = null;
        draft.ui.transcribedText = null;
      });
    });
  }
}
