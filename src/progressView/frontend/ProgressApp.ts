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
  AGENT_CATEGORY,
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
  getStreamState,
  isToolUseState,
  type ProgressState,
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
  EMPTY_STREAM_CONTEXT,
  permissionsContext,
  streamStateContext,
  type StreamContextValue,
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

  @provide({ context: permissionsContext })
  @state()
  private permissionsContextValue: PermissionState[] = [];

  // Container ref for accessing child component methods (FollowUpInput)
  private toolUseContentRef = createRef<ToolUseStreamContent>();

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
    if (changed.has('appState') || changed.has('permissions')) {
      const previousState = changed.get('appState') as
        | ProgressState
        | undefined;
      const activeStreamId = this.appState.activeStreamId;
      const previousActiveStreamId = previousState?.activeStreamId ?? null;
      // Only update stream context if active stream or its state changed
      const newStreamState = activeStreamId
        ? this.appState.streamStates.get(activeStreamId)
        : null;
      const followupOptionsChanged =
        !!activeStreamId &&
        previousState?.followupOptionsByStream.get(activeStreamId) !==
          this.appState.followupOptionsByStream.get(activeStreamId);
      if (
        this.streamContextValue.streamState !== newStreamState ||
        changed.has('permissions') ||
        activeStreamId !== previousActiveStreamId ||
        followupOptionsChanged
      ) {
        this.updateStreamContext();
      }
    }
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

  private getActiveStreamInfo(): StreamTabInfo | null {
    if (!this.appState.activeStreamId) return null;
    const filtered = getFilteredStreams(this.appState);
    return (
      filtered.find((stream) => stream.name === this.appState.activeStreamId) ??
      null
    );
  }

  private updateStreamContext(): void {
    const activeStream = this.getActiveStreamInfo();
    if (!activeStream) {
      this.streamContextValue = EMPTY_STREAM_CONTEXT;
      this.permissionsContextValue = this.permissions;
      return;
    }

    const streamState = getStreamState(
      this.appState,
      activeStream.name,
      activeStream.agentCategory,
    );
    const isToolUse = isToolUseState(streamState);
    const runId = getEffectiveRunId(streamState, { mode: 'fallback' });

    this.streamContextValue = {
      streamInfo: activeStream,
      streamState,
      runId,
      followupOptions:
        this.appState.followupOptionsByStream.get(activeStream.name) ?? null,
      isToolUse,
    };
    this.permissionsContextValue = this.permissions;
  }

  private setStreamState(
    streamId: StreamTabId,
    updater: (prev: StreamState) => StreamState,
  ): void {
    const nextStates = new Map(this.appState.streamStates);
    const streamInfo = this.appState.streams.find(
      (stream) => stream.name === streamId,
    );
    const current = getStreamState(
      this.appState,
      streamId,
      streamInfo?.agentCategory,
    );
    nextStates.set(streamId, updater(current));
    this.appState = { ...this.appState, streamStates: nextStates };
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
      getFollowUpRef: () => this.getFollowUpRef(),
      savePrefs: (prefs) => this.prefsManager.update(prefs),
    };
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
      if (prev.kind !== AGENT_CATEGORY.TOOL_USE) return prev;
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
