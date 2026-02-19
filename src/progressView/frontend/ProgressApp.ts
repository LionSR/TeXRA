// Third-party imports
import { html, css, nothing, type TemplateResult } from 'lit';
import { provide } from '@lit/context';
import { customElement, state } from 'lit/decorators.js';
import { createRef, ref, type Ref } from 'lit/directives/ref.js';
import { repeat } from 'lit/directives/repeat.js';

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
import './components/StreamPanel';
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

  /**
   * Per-stream refs for ToolUseStreamContent — used for imperative
   * FollowUpInput access (focus, polish). Keyed by streamId.
   */
  private toolUseContentRefs = new Map<string, Ref<ToolUseStreamContent>>();

  /**
   * Set of stream IDs that have been viewed during this session.
   * Their DOM subtrees are preserved (hidden) when switching away,
   * enabling instant tab switching without DOM reconstruction.
   *
   * Not @state: updated in willUpdate() before render(), driven by
   * appState changes. Mutated in-place for efficiency.
   */
  private visitedStreamIds = new Set<string>();

  /**
   * Memoized filtered+sorted stream list, recomputed once per willUpdate()
   * cycle. Shared between render() and updateStreamContext() to avoid
   * redundant sort/filter on every call.
   */
  private cachedFilteredStreams: StreamTabInfo[] = [];

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

    if (changed.has('appState')) {
      const prevAppState = changed.get('appState') as
        | ProgressState
        | undefined;

      // Re-sort streams when the list or sort/filter criteria change.
      if (
        !prevAppState ||
        prevAppState.streams !== this.appState.streams ||
        prevAppState.streamFilter !== this.appState.streamFilter ||
        prevAppState.streamSort !== this.appState.streamSort
      ) {
        this.cachedFilteredStreams = getFilteredStreams(this.appState);
      }

      // Track visited streams for DOM caching
      this.updateVisitedStreams();
    }

    this.updateContexts();
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
   * Render all visited stream panels.
   *
   * Each stream gets a `<stream-panel>` wrapper that provides per-stream
   * contexts. The active panel is visible (`display: contents`); all others
   * are hidden (`display: none`). DOM is preserved when switching — no
   * destruction/recreation, no re-formatting of log entries.
   *
   * Unvisited streams have zero DOM cost. Only streams the user has
   * actually viewed during this session are kept in memory.
   */
  private renderStreamContent(): TemplateResult {
    if (this.visitedStreamIds.size === 0) {
      // No visited streams - show empty log-list placeholder
      return html`<log-list></log-list>`;
    }

    return html`${repeat(
      [...this.visitedStreamIds],
      (id) => id,
      (id) => this.renderStreamPanel(id),
    )}`;
  }

  /** Render a single stream panel with per-stream context provider. */
  private renderStreamPanel(
    streamId: string,
  ): TemplateResult | typeof nothing {
    const streamInfo = this.appState.streams.find(
      (s) => s.name === streamId,
    );
    if (!streamInfo) return nothing;

    const streamState = getStreamState(
      this.appState,
      streamId,
      streamInfo.agentCategory,
    );
    const streamLogs =
      this.appState.streamLogs.get(streamId) ?? EMPTY_STREAM_LOGS;
    const followupOptions =
      this.appState.followupOptionsByStream.get(streamId) ?? null;
    const isActive = streamId === this.appState.activeStreamId;
    const isToolUse = isToolUseState(streamState);

    return html`
      <stream-panel
        ?hidden=${!isActive}
        .streamInfo=${streamInfo}
        .streamState=${streamState}
        .streamLogs=${streamLogs}
        .followupOptions=${followupOptions}
        .hasStreams=${this.cachedFilteredStreams.length > 0}
      >
        ${isToolUse
          ? html`
              <tool-use-stream-content
                ${ref(this.getOrCreateToolUseRef(streamId))}
                @toolbar-command=${this.onToolbarCommand}
                @permission-action=${this.onPermissionAction}
                @followup-change=${this.onFollowUpChange}
                @followup-send=${this.onFollowUpSend}
                @followup-polish=${this.onFollowUpPolish}
                @followup-clear=${this.onFollowUpClear}
                @followup-focus-complete=${this.onFollowUpFocusComplete}
              ></tool-use-stream-content>
            `
          : html`
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
            `}
      </stream-panel>
    `;
  }

  protected handleMessage(raw: unknown): void {
    // Schema-driven dispatch - parses once with discriminated union,
    // then routes to typed handler
    dispatchMessage(raw, this.createMessageHandlerContext());
  }

  /**
   * Update app-level contexts.
   *
   * Per-stream data (streamStateContext, streamLogContext) is now provided
   * by individual StreamPanel wrappers. The app-level providers serve as
   * fallback for the empty state (when no StreamPanel is in the tree).
   *
   * Permissions context remains app-level since it's stream-independent.
   */
  private updateContexts(): void {
    const hasStreams = this.cachedFilteredStreams.length > 0;

    // App-level stream contexts: only update when hasStreams changes.
    // StreamPanel shadows these for its children with per-stream data.
    if (this.streamLogContextValue.hasStreams !== hasStreams) {
      this.streamLogContextValue = { ...EMPTY_LOG_CONTEXT, hasStreams };
    }
    if (this.streamContextValue.hasStreams !== hasStreams) {
      this.streamContextValue = { ...EMPTY_STREAM_CONTEXT, hasStreams };
    }

    this.permissionsContextValue = this.permissions;
  }

  /**
   * Track visited streams for DOM caching.
   * Add active stream to the visited set; remove deleted streams.
   */
  private updateVisitedStreams(): void {
    const activeId = this.appState.activeStreamId;
    if (activeId) {
      this.visitedStreamIds.add(activeId);
    }

    // Remove streams that no longer exist
    const currentIds = new Set(this.appState.streams.map((s) => s.name));
    for (const id of this.visitedStreamIds) {
      if (!currentIds.has(id)) {
        this.visitedStreamIds.delete(id);
        this.toolUseContentRefs.delete(id);
      }
    }
  }

  /** Get or create a ref for a tool-use stream's content component. */
  private getOrCreateToolUseRef(
    streamId: string,
  ): Ref<ToolUseStreamContent> {
    let r = this.toolUseContentRefs.get(streamId);
    if (!r) {
      r = createRef<ToolUseStreamContent>();
      this.toolUseContentRefs.set(streamId, r);
    }
    return r;
  }

  private setStreamState(
    streamId: StreamTabId,
    updater: (prev: StreamState) => StreamState,
  ): void {
    // Fast path: stream already has state (common during streaming).
    // Only fall back to streams.find() when creating default state for new streams.
    let current = this.appState.streamStates.get(streamId);
    if (!current) {
      const streamInfo = this.appState.streams.find(
        (stream) => stream.name === streamId,
      );
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
      getFollowUpRef: () => {
        const activeId = this.appState.activeStreamId;
        if (!activeId) return undefined;
        return this.toolUseContentRefs.get(activeId)?.value?.getFollowUpRef();
      },
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
