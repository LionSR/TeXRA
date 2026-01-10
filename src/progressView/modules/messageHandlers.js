// Local imports - progress view
import {
  COMMANDS,
  STREAM_STATUS,
  ELEMENT_IDS,
  GROUP_DOM_IDS,
} from './constants.js';
import { progressViewDomHandler } from './domHandlers.js';
import { createThemeHandlers } from './handlers/themeHandlers.js';
import { appendFormatted } from './utils.js';
import { getSharedLogEntryFormatter } from './formatters/index.js';
// Local imports - log state
import { progressViewState } from './progressViewState.js';
import { BaseWebviewMessageHandler } from '@common/BaseWebviewMessageHandler.js';
import { vscode } from '@common/webviewContext.js';
import { scrollToBottom, setRadioGroupValue } from '@common/domUtils.js';

// Session kind values match TypeScript AgentSessionKind enum
// No need to duplicate - we use the actual values from messages

// Create shorter aliases for internal use
const state = progressViewState;
const dom = progressViewDomHandler;
const pendingLogUpdates = new Map();

// DIAGNOSTIC: Event sequence counter for debugging reload issues
let _eventSequence = 0;
const _logEvent = (name, data) => {
  console.log(`[SEQ ${++_eventSequence}] ${name}`, data);
};

// Create formatter instances

export class ProgressViewMessageHandler extends BaseWebviewMessageHandler {
  constructor() {
    super();
    this._entryFormatter = getSharedLogEntryFormatter();
    this._handlers = {
      ...createThemeHandlers(),
      ...this._createHandlers(),
    };
    this._runSelectorDispose = dom.runSelector.onDidChange((runId) =>
      this._handleRunSelectionChange(runId),
    );
    window.addEventListener(
      'unload',
      () => {
        this.dispose();
      },
      { once: true },
    );
  }

  dispose() {
    if (typeof this._runSelectorDispose === 'function') {
      this._runSelectorDispose();
      this._runSelectorDispose = null;
    }
  }

  _updatePlaceholderVisibility() {
    if (state.hasStreams()) {
      dom.placeholder.hide();
    } else {
      dom.placeholder.show();
    }
  }

  _handleRunSelectionChange(runId) {
    const activeStream = state.activeStream || null;
    if (activeStream) {
      state.setActiveRunId(activeStream, runId);
    }
    dom.taskGroups.showRun(runId);
    // Pass runId directly to avoid redundant resolveActiveRunId calls
    this._refreshInstructionForActiveRun(runId);
    this._refreshOutputsForActiveRun(runId);
    this._refreshUsageForActiveRun();
  }

  /**
   * Get active run context (stream and resolved runId).
   * @param {string} [runIdHint] - Optional runId to use instead of resolving
   * @returns {{ stream: string, runId: string } | null}
   */
  _getActiveRunContext(runIdHint) {
    const stream = state.activeStream || null;
    if (!stream) return null;
    const runId = runIdHint ?? state.resolveActiveRunId(stream);
    return runId ? { stream, runId } : null;
  }

  /**
   * Refresh instruction panel for the active run.
   * @param {string} [runId] - Optional runId to use instead of resolving
   */
  _refreshInstructionForActiveRun(runId) {
    if (state.activeSessionKind === 'toolUse') {
      dom.instructionPanel.hide();
      return;
    }

    const ctx = this._getActiveRunContext(runId);
    if (!ctx) {
      dom.instructionPanel.hide();
      return;
    }

    const instruction = state.getRunInstruction(ctx.stream, ctx.runId);
    if (instruction && instruction.text) {
      dom.instructionPanel.show(instruction.text, instruction.metadata);
    } else {
      dom.instructionPanel.hide();
    }
  }

  /**
   * Refresh output files for the active run.
   * @param {string} [runId] - Optional runId to use instead of resolving
   */
  _refreshOutputsForActiveRun(runId) {
    const ctx = this._getActiveRunContext(runId);
    const filesByRound = ctx
      ? (state.getRunFiles(ctx.stream, ctx.runId) ?? {})
      : {};
    // Hide round headers for tool-use agents where round numbers don't have meaning
    const showRoundHeaders = state.activeSessionKind !== 'toolUse';
    dom.fileList.update(filesByRound, { showRoundHeaders });
  }

  _refreshUsageForActiveRun() {
    dom.usageSummary.update();
  }

  /**
   * Refresh context state display for the active stream.
   * Clears display if stream has no context state.
   */
  _refreshContextStateForActiveStream() {
    const stream = state.activeStream;
    const contextState = stream ? state.getContextState(stream) : null;
    if (contextState) {
      dom.usageSummary.updateContextDisplay(contextState);
    } else {
      dom.usageSummary.clearContextDisplay();
    }
  }

  /**
   * Refresh all active run panels (instruction, outputs, usage, context).
   * Consolidates the four refresh methods that are commonly called together.
   * @param {string} [runId] - Optional runId to use instead of resolving
   */
  _refreshActiveRunPanels(runId) {
    this._refreshInstructionForActiveRun(runId);
    this._refreshOutputsForActiveRun(runId);
    this._refreshUsageForActiveRun();
    this._refreshContextStateForActiveStream();
  }

  /**
   * Auto-focus follow-up input when status is WAITING.
   * Extracted to avoid duplication in handleUpdateStreams and handleUpdateStreamStatus.
   * @param {string} status - The stream status to check
   */
  _focusFollowUpIfWaiting(status) {
    if (status === STREAM_STATUS.WAITING) {
      dom.followUpInput.focus({ scrollIntoView: true });
    }
  }

  /**
   * Clear stale state when switching between session kinds.
   * Different session kinds have incompatible task group structures:
   * - Workflow sessions create hierarchical task groups
   * - Tool-use sessions don't create task groups at all
   * Stale groups from previous sessions interfere with run ID resolution.
   *
   * NOTE: Log content is NOT cleared here. It's handled by handleUpdateLogs
   * with forceRebuild: true, which properly coordinates clearing with
   * re-rendering. Clearing here would cause data loss when UPDATE_LOGS
   * arrives with forceRebuild: false (same stream, incremental update).
   *
   * @param {string} newSessionKind - The new session kind being switched to
   * @returns {boolean} true if state was cleared
   */
  _clearSessionKindState(newSessionKind) {
    const shouldClear =
      newSessionKind !== state.activeSessionKind && state.activeSessionKind;
    // DIAGNOSTIC: Track session kind state changes
    _logEvent('CLEAR_SESSION_KIND_STATE', {
      newSessionKind,
      currentSessionKind: state.activeSessionKind,
      shouldClear,
      taskGroupCount: state.taskGroups?.size ?? 0,
    });
    if (shouldClear) {
      _logEvent('TASK_GROUPS_CLEARED', {
        reason: 'session kind change',
        previousKind: state.activeSessionKind,
        newKind: newSessionKind,
      });
      state.taskGroups.clear();
      dom.taskGroups.clear();
    }
    return shouldClear;
  }

  /**
   * Clear DOM panels when active stream is removed or all streams deleted.
   * Shared between handleDeleteStream and handleDeleteAll.
   */
  _clearActivePanels() {
    dom.instructionPanel.hide();
    dom.runSelector.clear();
    dom.todoList.clear();
    dom.queuedFollowUps.clear();
    dom.fileList.clear();
    dom.usageSummary.clearContextDisplay();
  }

  /**
   * Clear run-scoped state for a specific stream.
   * Shared between handleDeleteStream (single stream) and handleDeleteAll (all streams).
   * @param {string} stream - The stream to clear, or null to clear all
   */
  _clearRunScopedState(stream) {
    if (stream) {
      // Clear stream-specific state
      state.clearExecutionIdAvailability(stream);
      state.clearActiveRun(stream);
      state.clearRunInstructions(stream);
      state.clearRunFiles(stream);
      state.clearRunMissingOutputs(stream);
      state.clearRunUsage(stream);
      state.clearTodos(stream);
      state.clearQueuedFollowUps(stream);
      state.clearContextState(stream);
      state.clearFollowUpText(stream);
    } else {
      // Clear all state
      state.resetExecutionIdAvailability();
      state.clearAllActiveRuns();
      state.clearRunInstructions();
      state.clearRunFiles();
      state.clearRunMissingOutputs();
      state.clearRunUsage();
      state.clearAllTodos();
      state.clearAllQueuedFollowUps();
      state.clearContextState();
      state.clearAllFollowUpText();
    }
  }

  /**
   * Determine session kind from stream info with fallback to current state.
   * @param {Object|undefined} streamInfo - The active stream's info object
   * @returns {string} The session kind ('workflow' or 'toolUse')
   */
  _resolveSessionKind(streamInfo) {
    if (!streamInfo) return state.activeSessionKind || 'workflow';
    return (
      streamInfo.agentSessionKind ||
      streamInfo.uiTraits?.sessionKind ||
      'workflow'
    );
  }

  /**
   * Sync agent filter radio button UI with current state.
   */
  _syncAgentFilterRadios() {
    const radioGroup = document.getElementById(
      ELEMENT_IDS.AGENT_FILTER_CONTAINER,
    );
    setRadioGroupValue(radioGroup, state.agentTypeFilter);
  }

  /**
   * Resolve preferred run ID from available runs, preserving user preference.
   * @param {string[]} runIds - Available run IDs
   * @param {string|null} messageRunId - Run ID from message (highest priority)
   * @param {string|null} previousRunId - Previously active run ID (fallback)
   * @returns {string|undefined} The preferred run ID or undefined
   */
  _resolvePreferredRunId(runIds, messageRunId, previousRunId) {
    if (messageRunId && runIds.includes(messageRunId)) return messageRunId;
    if (previousRunId && runIds.includes(previousRunId)) return previousRunId;
    return runIds.at(-1);
  }

  /**
   * Render a log message to its appropriate container.
   * Attempts to append to group first, falls back to main log content.
   * @param {Object} msg - The log message to render
   * @param {HTMLElement} logContent - The main log content container
   * @returns {void} No return value; dom.logEntries.append returns truthy on success
   */
  _renderLogMessage(msg, logContent) {
    // dom.logEntries.append returns true if message was added to its group container
    if (msg.groupId) {
      const wasAppendedToGroup = dom.logEntries.append(msg);
      // DIAGNOSTIC: Track grouped message handling
      if (!wasAppendedToGroup) {
        console.warn('[_renderLogMessage] Message has groupId but no container:', {
          messageType: msg.messageType,
          id: msg.id,
          groupId: msg.groupId,
        });
      }
      if (wasAppendedToGroup) return;
    }
    const formatted = this._entryFormatter.format(msg);
    // DIAGNOSTIC: Log if formatter returns null
    if (!formatted) {
      console.warn('[_renderLogMessage] Formatter returned null for:', {
        messageType: msg.messageType,
        id: msg.id,
        hasText: Boolean(msg.text),
        hasData: Boolean(msg.data),
        groupId: msg.groupId,
      });
    }
    appendFormatted(logContent, formatted);
  }

  /**
   * Apply run-scoped data to state using the provided setter.
   * @param {string} stream - The stream to update
   * @param {Object|undefined} data - Run data mapping runId → value
   * @param {Function} setter - State setter function (stream, runId, value)
   */
  _applyRunData(stream, data, setter) {
    if (!data) return;
    for (const [runId, value] of Object.entries(data)) {
      if (runId) setter.call(state, stream, runId, value);
    }
  }

  /**
   * Update run-scoped metadata (instructions, usage, files, context) from message.
   * Shared by handleUpdateLogs and _handleIncrementalUpdate to avoid duplication.
   * @param {string} stream - The stream to update
   * @param {Object} message - Message containing runInstructions, runUsage, runFiles, contextState
   */
  _updateRunMetadata(stream, message) {
    // Apply run-scoped metadata
    this._applyRunData(
      stream,
      message.runInstructions,
      state.setRunInstruction,
    );
    this._applyRunData(stream, message.runUsage, state.setRunUsage);
    this._applyRunData(stream, message.runFiles, state.setRunFiles);

    // Context state is stream-scoped (not run-scoped)
    if (message.contextState) {
      state.setContextState(stream, message.contextState);
    }
  }

  // =========================================================================
  // Stream validation helpers - reduce duplication across 14+ handlers
  // =========================================================================

  /**
   * Check if message targets the active stream
   * @param {object} message - Message with optional stream property
   * @returns {boolean} true if message.stream matches activeStream
   */
  _isActiveStream(message) {
    return message.stream === state.activeStream;
  }

  /**
   * Get target stream from message with fallback to activeStream
   * @param {object} message - Message with optional stream property
   * @returns {string|null} The target stream or null if none available
   */
  _getTargetStream(message) {
    return message.stream || state.activeStream || null;
  }

  _createHandlers() {
    return {
      [COMMANDS.UPDATE_STREAMS]: this.handleUpdateStreams.bind(this),
      [COMMANDS.UPDATE_LOGS]: this.handleUpdateLogs.bind(this),
      [COMMANDS.APPEND_LOG]: this.handleAppendLog.bind(this),
      [COMMANDS.UPDATE_LOG]: this.handleUpdateLog.bind(this),
      [COMMANDS.ADD_TASK_GROUP]: this.handleAddTaskGroup.bind(this),
      [COMMANDS.UPDATE_TASK_GROUP]: this.handleUpdateTaskGroup.bind(this),
      [COMMANDS.UPDATE_STATUS]: this.handleUpdateStatus.bind(this),
      [COMMANDS.UPDATE_STREAM_STATUS]: this.handleUpdateStreamStatus.bind(this),
      [COMMANDS.UPDATE_USAGE]: this.handleUpdateUsage.bind(this),
      [COMMANDS.UPDATE_RUN_USAGE]: this.handleUpdateRunUsage.bind(this),
      [COMMANDS.UPDATE_CONTEXT_STATE]: this.handleUpdateContextState.bind(this),
      [COMMANDS.UPDATE_FILES]: this.handleUpdateFiles.bind(this),
      [COMMANDS.UPDATE_MISSING_OUTPUTS]:
        this.handleUpdateMissingOutputs.bind(this),
      [COMMANDS.SHOW_TOOL_EDIT_APPROVAL]:
        this.handleShowToolEditApproval.bind(this),
      [COMMANDS.RESOLVE_TOOL_EDIT_APPROVAL]:
        this.handleResolveToolEditApproval.bind(this),
      [COMMANDS.UPDATE_TOOL_EDIT_APPROVAL_STATE]:
        this.handleUpdateToolEditApprovalState.bind(this),
      [COMMANDS.SHOW_RETRY_REQUEST]: this.handleShowRetryRequest.bind(this),
      [COMMANDS.RESOLVE_RETRY_REQUEST]:
        this.handleResolveRetryRequest.bind(this),
      [COMMANDS.UPDATE_INSTRUCTION]: this.handleUpdateInstruction.bind(this),
      [COMMANDS.DELETE_STREAM]: this.handleDeleteStream.bind(this),
      [COMMANDS.DELETE_ALL]: this.handleDeleteAll.bind(this),
      [COMMANDS.FOLLOW_UP_TEXT_POLISHED]:
        this.handleFollowUpTextPolished.bind(this),
      [COMMANDS.FOLLOW_UP_TEXT_TRANSCRIBED]:
        this.handleFollowUpTextTranscribed.bind(this),
      [COMMANDS.RECORDING_STARTED]: this.handleRecordingStarted.bind(this),
      [COMMANDS.RECORDING_STOPPED]: this.handleRecordingStopped.bind(this),
      [COMMANDS.RECORDING_ERROR]: this.handleRecordingError.bind(this),
      [COMMANDS.UPDATE_TODOS]: this.handleUpdateTodos.bind(this),
      [COMMANDS.UPDATE_QUEUED_FOLLOW_UPS]:
        this.handleUpdateQueuedFollowUps.bind(this),
    };
  }

  handleUpdateStreams(message) {
    // DIAGNOSTIC: Log every UPDATE_STREAMS to understand reload failure
    _logEvent('UPDATE_STREAMS', {
      'message.activeStream': message.activeStream,
      'message.streams?.length': message.streams?.length,
      'state.activeStream (before)': state.activeStream,
      'state.lastRenderedStream': state.lastRenderedStream,
      'state.activeSessionKind (before)': state.activeSessionKind,
    });

    // Save follow-up text for the previous stream before switching
    const previousStream = state.activeStream;
    if (previousStream && previousStream !== message.activeStream) {
      dom.followUpInput.saveTextForStream(previousStream);
    }

    try {
      state.activeStream = message.activeStream;
      console.log('[UPDATE_STREAMS] state.activeStream set to:', state.activeStream);
      if (
        !state.pendingFilterUpdate &&
        message.agentFilter !== undefined &&
        message.agentFilter !== state.agentTypeFilter
      ) {
        state.agentTypeFilter = message.agentFilter;
      }
    } finally {
      state.pendingFilterUpdate = false;
    }
    state.resetExecutionIdAvailability();

    // Process streams - preserve ERROR status when omitted
    const streams = (message.streams ?? []).map((s) => {
      // Only preserve ERROR status; undefined means completed
      const cachedError = state.streamStatuses.get(s.name);
      const status =
        s.status ??
        (cachedError === STREAM_STATUS.ERROR ? cachedError : undefined);
      state.streamStatuses.set(s.name, status);
      state.setExecutionIdAvailable(s.name, Boolean(s.executionId));
      return { ...s, status };
    });

    state.setStreams(streams.map((s) => s.name));
    dom.streamTabs.update(streams, message.activeStream);
    this._syncAgentFilterRadios();

    this._updatePlaceholderVisibility();

    const activeStreamInfo = streams.find(
      (s) => s.name === message.activeStream,
    );
    const sessionKind = this._resolveSessionKind(activeStreamInfo);
    const isToolAgent = sessionKind === 'toolUse';

    // DIAGNOSTIC: Log session kind resolution
    _logEvent('SESSION_KIND_RESOLVE', {
      hasActiveStreamInfo: Boolean(activeStreamInfo),
      'activeStreamInfo.agentSessionKind': activeStreamInfo?.agentSessionKind,
      'activeStreamInfo.uiTraits?.sessionKind':
        activeStreamInfo?.uiTraits?.sessionKind,
      resolvedSessionKind: sessionKind,
      'state.activeSessionKind (current)': state.activeSessionKind,
    });

    // Only clear session state if we have confirmed stream info for the session kind change
    if (activeStreamInfo) {
      this._clearSessionKindState(sessionKind);
    }
    state.activeSessionKind = sessionKind;

    dom.runSelector.setDisplayEnabled(
      Boolean(message.activeStream) && !isToolAgent,
    );

    const container = document.getElementById(ELEMENT_IDS.FOLLOW_UP_CONTAINER);
    if (container) {
      container.classList.toggle('is-visible', isToolAgent);
      container.setAttribute('aria-hidden', isToolAgent ? 'false' : 'true');
    }
    dom.followUpInput.setContainerVisibility(Boolean(isToolAgent && container));

    // Restore follow-up text for the new stream
    if (message.activeStream && previousStream !== message.activeStream) {
      dom.followUpInput.restoreTextForStream(message.activeStream);
    }

    dom.approvalRequests.setActiveStream(message.activeStream, isToolAgent);
    dom.retryRequests.setActiveStream(message.activeStream, isToolAgent);

    dom.toolbar.render(sessionKind);

    const hasExecution = state.hasExecutionId(message.activeStream);
    dom.status.setExecutionIdAvailability(Boolean(hasExecution));

    // Update status based on whether there's an active stream
    if (!message.activeStream) {
      dom.status.update(STREAM_STATUS.READY);
      dom.instructionPanel.hide();
      dom.runSelector.clear();
      dom.todoList.clear();
      dom.queuedFollowUps.clear();
      dom.fileList.clear();
      // Clear log content when no stream is active to avoid stale content
      const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
      if (logContent) {
        logContent.innerHTML = '';
      }
      // Reset lastRenderedStream since we cleared content
      state.lastRenderedStream = '';
      state.clearRunInstructions();
      state.clearAllActiveRuns();
      state.clearAllPendingInstructions();
      state.clearAllTodos();
      state.clearAllQueuedFollowUps();
      state.clearAllFollowUpText();
    } else {
      const streamStatus = state.streamStatuses.get(message.activeStream);
      dom.status.update(streamStatus || STREAM_STATUS.STOPPED);
      // Refresh todos for the active stream
      const todos = state.getTodos(message.activeStream);
      dom.todoList.update(todos ?? []);
      // Refresh queued follow-ups for the active stream
      const queuedFollowUps = state.getQueuedFollowUps(message.activeStream);
      dom.queuedFollowUps.update(queuedFollowUps ?? []);
      this._focusFollowUpIfWaiting(streamStatus);
    }

    this._refreshActiveRunPanels();
  }

  handleUpdateLogs(message) {
    // DIAGNOSTIC: Log every UPDATE_LOGS to understand reload failure
    _logEvent('UPDATE_LOGS', {
      'message.stream': message.stream,
      'state.activeStream': state.activeStream,
      'state.lastRenderedStream': state.lastRenderedStream,
      'message.messages?.length': message.messages?.length,
      'message.action': message.action,
      '_isActiveStream': message.stream === state.activeStream,
    });

    if (!this._isActiveStream(message)) {
      // DIAGNOSTIC: This is the suspected bug - messages being dropped
      console.warn('[UPDATE_LOGS] DROPPED - activeStream mismatch!', {
        expected: state.activeStream,
        received: message.stream,
        messagesDropped: message.messages?.length ?? 0,
      });
      this._updatePlaceholderVisibility();
      return;
    }

    const logMessages = message.messages ?? [];

    // Action-based rebuild strategy (simpler than boolean flags):
    //
    // action: 'clear' → Explicitly clear DOM content (no active stream, stream deleted)
    // action: 'render' (default) → Send data to display, frontend decides:
    //   - Stream switch (message.stream !== lastRenderedStream) → Full rebuild
    //   - Same stream → Incremental update (just metadata)
    //
    // This design moves stream switch detection to the frontend, which tracks
    // lastRenderedStream. Backend just sends data with intent, no longer tracks
    // what was rendered. The frontend is the single source of truth for render state.
    const action = message.action ?? 'render';
    const isExplicitClear = action === 'clear';
    const isStreamSwitch = message.stream !== state.lastRenderedStream;

    // Determine if we need full rebuild:
    // - Explicit clear: always clear (even without messages)
    // - Stream switch: always clear (user switched, expects different content)
    // - Same stream: incremental update only (metadata changes, messages via APPEND_LOG)
    //
    // Note: Stream switch ALWAYS triggers full rebuild, even with empty messages.
    // Showing empty content for a new stream is correct; showing the previous
    // stream's content would be confusing and a source of bugs.
    const shouldFullRebuild = isExplicitClear || isStreamSwitch;

    if (!shouldFullRebuild) {
      this._handleIncrementalUpdate(message);
      this._updatePlaceholderVisibility();
      return;
    }

    // Full rebuild path: clear and rebuild
    // DIAGNOSTIC: Track full rebuild clearing
    _logEvent('FULL_REBUILD_START', {
      'message.stream': message.stream,
      'state.lastRenderedStream': state.lastRenderedStream,
      isExplicitClear,
      isStreamSwitch,
      'message.groups?.length': message.groups?.length,
      'message.messages?.length': message.messages?.length,
    });
    const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    pendingLogUpdates.clear();
    dom.taskGroups.clear();
    state.taskGroups.clear();
    state.clearRunInstructions(message.stream);
    state.clearRunFiles(message.stream);
    state.clearRunUsage(message.stream);
    state.clearPendingInstruction(state.activeStream);
    const previousRunId = state.getActiveRunId(message.stream);
    state.clearActiveRun(message.stream);
    logContent.innerHTML = '';
    const groups = message.groups ?? [];

    // Always update run metadata (instructions, usage, files) regardless of groups
    // Tool-use sessions don't create task groups but still have usage data
    this._updateRunMetadata(message.stream, message);

    if (groups.length > 0) {
      const parentGroups = groups.filter((g) => !g.parentGroupId);
      dom.runSelector.setRuns(parentGroups);
      dom.taskGroups.renderInitial(groups);

      if (parentGroups.length > 0) {
        const runIds = parentGroups.map((g) => g.id);
        const preferredRun = this._resolvePreferredRunId(
          runIds,
          message.activeRunId,
          previousRunId,
        );
        state.setActiveRunId(message.stream, preferredRun);
        dom.runSelector.setActiveRun(preferredRun);
        dom.taskGroups.showRun(preferredRun);
      } else {
        dom.taskGroups.showRun(null);
      }

      // Sync state if resolution differs
      const resolvedRunId = state.resolveActiveRunId(message.stream);
      if (
        resolvedRunId &&
        state.getActiveRunId(message.stream) !== resolvedRunId
      ) {
        state.setActiveRunId(message.stream, resolvedRunId);
      }
    } else {
      dom.taskGroups.showRun(null);
    }

    // DIAGNOSTIC: Log before rendering
    _logEvent('RENDER_START', { messageCount: logMessages.length });
    let renderedCount = 0;
    logMessages.forEach((msg) => {
      this._renderLogMessage(msg, logContent);
      renderedCount++;
    });
    _logEvent('RENDER_COMPLETE', {
      renderedCount,
      logContentChildCount: logContent?.childElementCount,
      logContentInnerHTMLLength: logContent?.innerHTML?.length,
    });
    scrollToBottom(logContent);

    // Use validated run ID from state (set earlier via setActiveRunId after validation)
    const activeRunId = state.resolveActiveRunId(message.stream);
    this._refreshActiveRunPanels(activeRunId);

    // Update lastRenderedStream AFTER successful render.
    // This is the single source of truth for stream switch detection.
    state.lastRenderedStream = message.stream;

    // DIAGNOSTIC: Final state after render
    const finalLogContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    const computedStyle = finalLogContent
      ? window.getComputedStyle(finalLogContent)
      : null;
    const firstChild = finalLogContent?.firstElementChild;
    const firstChildStyle = firstChild
      ? window.getComputedStyle(firstChild)
      : null;
    _logEvent('FINAL_STATE', {
      logContentChildCount: finalLogContent?.childElementCount,
      logContentInnerHTMLLength: finalLogContent?.innerHTML?.length,
      taskGroupStateCount: state.taskGroups?.groups?.size,
      taskGroupDOMCount:
        finalLogContent?.querySelectorAll('[data-group-id]')?.length,
      'state.activeSessionKind': state.activeSessionKind,
      'state.lastRenderedStream': state.lastRenderedStream,
      // CSS visibility checks
      logContentDisplay: computedStyle?.display,
      logContentVisibility: computedStyle?.visibility,
      logContentHidden: finalLogContent?.hidden,
      firstChildDisplay: firstChildStyle?.display,
      firstChildHidden: firstChild?.hidden,
    });

    this._updatePlaceholderVisibility();
  }

  /**
   * Handle incremental update - update state without DOM rebuild.
   * Used when refreshing the same stream to avoid expensive full rebuild.
   *
   * Limitations (by design):
   * - Log messages are NOT appended here; they arrive via APPEND_LOG command
   * - Only group status/endTime are updated; other group fields are immutable post-creation
   * - New groups are NOT created; they arrive via ADD_TASK_GROUP command
   * - Stream status is NOT updated here; it arrives via UPDATE_STREAM_STATUS command
   */
  _handleIncrementalUpdate(message) {
    // Defensive guard: caller should verify stream matches active stream
    if (!this._isActiveStream(message)) {
      console.debug(
        `[incremental] stream mismatch: ${message.stream} !== ${state.activeStream}`,
      );
      return;
    }

    // Update run-scoped metadata using shared helper
    // Skip DOM reconstruction since content hasn't changed
    this._updateRunMetadata(message.stream, message);

    // Update task group statuses if they changed
    // Note: Only status/endTime are expected to change post-creation
    const groups = message.groups ?? [];
    groups.forEach((group) => {
      const existing = state.taskGroups.get(group.id);
      if (!existing) {
        // New group during incremental update - this shouldn't happen
        // Groups should arrive via ADD_TASK_GROUP command
        console.debug(
          `[incremental] unexpected new group ${group.id} - skipping`,
        );
        return;
      }
      if (existing.status !== group.status) {
        const updatePayload = {
          id: group.id,
          status: group.status,
          endTime: group.endTime,
        };
        state.taskGroups.update(updatePayload);
        dom.taskGroups.updateGroup(updatePayload);
      }
    });

    // Refresh display panels - use validated run ID from state
    const activeRunId = state.resolveActiveRunId(message.stream);
    this._refreshActiveRunPanels(activeRunId);
  }

  handleAppendLog(message) {
    if (this._isActiveStream(message)) {
      const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
      const logId = message.logMessage?.id;
      const pendingUpdate = logId ? pendingLogUpdates.get(logId) : null;
      const mergedLogMessage = pendingUpdate
        ? { ...message.logMessage, ...pendingUpdate }
        : message.logMessage;
      if (logId && pendingUpdate) {
        pendingLogUpdates.delete(logId);
      }

      const messageType = mergedLogMessage.messageType;
      const shouldAutoExpand =
        messageType === 'thinking' || messageType === 'scratchpad';
      const formatOptions = shouldAutoExpand
        ? { defaultOpen: true }
        : undefined;

      const addedToGroup = dom.logEntries.append(
        mergedLogMessage,
        formatOptions,
      );
      if (!addedToGroup) {
        const formatted = this._entryFormatter.format(
          mergedLogMessage,
          formatOptions,
        );
        appendFormatted(logContent, formatted);
      }
      scrollToBottom(logContent);
    }

    this._updatePlaceholderVisibility();
  }

  handleUpdateLog(message) {
    if (this._isActiveStream(message)) {
      const updated = dom.logEntries.update(message.logMessage);
      if (!updated) {
        const logId = message.logMessage?.id;
        if (logId) {
          const existingUpdate = pendingLogUpdates.get(logId) ?? {};
          pendingLogUpdates.set(logId, {
            ...existingUpdate,
            ...message.logMessage,
          });
        }
      }
    }
  }

  handleAddTaskGroup(message) {
    if (this._isActiveStream(message)) {
      const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
      dom.taskGroups.addGroup(message.group);
      if (message.group && !message.group.parentGroupId) {
        dom.runSelector.addRun(message.group);
        const newRunId = message.group.id;
        const targetStream = state.activeStream || message.stream || null;
        if (targetStream) {
          state.setActiveRunId(targetStream, newRunId);
        }
        const pending = targetStream
          ? state.takePendingInstruction(targetStream)
          : null;
        if (pending) {
          state.setRunInstruction(targetStream, newRunId, pending);
        } else if (targetStream) {
          state.clearRunInstruction(targetStream, newRunId);
        }
        if (targetStream) {
          state.deleteRunFiles(targetStream, message.group.id);
          state.deleteRunMissingOutputs(targetStream, message.group.id);
        }
        dom.runSelector.setActiveRun(newRunId);
        dom.taskGroups.showRun(newRunId);
        // Pass newRunId directly to avoid redundant resolveActiveRunId calls
        this._refreshInstructionForActiveRun(newRunId);
        this._refreshOutputsForActiveRun(newRunId);
        this._refreshUsageForActiveRun();
      }
      scrollToBottom(logContent);
    }

    this._updatePlaceholderVisibility();
  }

  handleUpdateTaskGroup(message) {
    const update = message?.update;
    if (!update) {
      return;
    }

    if (update.stream === state.activeStream) {
      state.taskGroups.update(update);
      dom.taskGroups.updateGroup(update);
    }
  }

  handleUpdateStatus(message) {
    const hasExecution = state.hasExecutionId(state.activeStream);
    dom.status.setExecutionIdAvailability(Boolean(hasExecution));
    dom.status.update(message.status);

    const targetsActiveStream =
      !message.stream || message.stream === state.activeStream;
    if (!targetsActiveStream) {
      return;
    }

    if (message.status === STREAM_STATUS.WAITING) {
      dom.followUpInput.focus({ scrollIntoView: true });
    }
  }

  /**
   * Handle targeted single-stream status update.
   * More efficient than UPDATE_STREAMS when only status changed.
   */
  handleUpdateStreamStatus(message) {
    const { stream, status, lastTimestamp } = message;
    if (!stream) {
      return;
    }

    // Validate status against known values
    const validStatuses = Object.values(STREAM_STATUS);
    if (status && !validStatuses.includes(status)) {
      console.debug(
        `[updateStreamStatus] Invalid status "${status}" for stream: ${stream}`,
      );
      return;
    }

    // Always update state first - state is the single source of truth.
    // If tab doesn't exist yet (race condition), UPDATE_STREAMS will read
    // from state.streamStatuses and apply the status when creating the tab.
    if (status && status !== STREAM_STATUS.READY) {
      state.streamStatuses.set(stream, status);
    } else {
      state.streamStatuses.delete(stream);
    }

    // Attempt DOM update (may fail if tab doesn't exist yet, which is OK)
    dom.streamTabs.updateStreamStatus(stream, status, lastTimestamp);

    // Also update main status indicator if this is the active stream
    if (stream === state.activeStream) {
      dom.status.update(status || STREAM_STATUS.STOPPED);
      this._focusFollowUpIfWaiting(status);
    }
  }

  handleUpdateUsage(message) {
    if (message.stream && !this._isActiveStream(message)) {
      return;
    }

    const targetStream = this._getTargetStream(message);
    if (!targetStream) {
      return;
    }

    state.clearRunUsage(targetStream);
    const usageByRun = message.usageByRun ?? {};
    Object.entries(usageByRun).forEach(([runId, usage]) => {
      state.setRunUsage(targetStream, runId, usage);
    });
    this._refreshUsageForActiveRun();
  }

  /**
   * Handle incremental usage update for a single run.
   * More efficient than handleUpdateUsage during streaming.
   */
  handleUpdateRunUsage(message) {
    if (message.stream && !this._isActiveStream(message)) {
      return;
    }

    const targetStream = this._getTargetStream(message);
    if (!targetStream || !message.runId) {
      return;
    }

    // Update only the specific run's usage without clearing others
    state.setRunUsage(targetStream, message.runId, message.usage);
    this._refreshUsageForActiveRun();
  }

  /**
   * Handle context state update (input tokens vs context window).
   * Updates the context utilization display in the footer.
   */
  handleUpdateContextState(message) {
    if (message.stream && !this._isActiveStream(message)) {
      return;
    }

    const targetStream = this._getTargetStream(message);
    if (!targetStream || !message.contextState) {
      return;
    }

    state.setContextState(targetStream, message.contextState);
    // Update the context display if this is the active stream
    if (targetStream === state.activeStream) {
      dom.usageSummary.updateContextDisplay(message.contextState);
    }
  }

  handleUpdateFiles(message) {
    const targetStream = this._getTargetStream(message);
    if (!targetStream) return;

    if (message.reset) {
      state.clearRunFiles(targetStream);
    } else if (message.runId) {
      const hasRounds =
        message.rounds && Object.keys(message.rounds).length > 0;
      if (hasRounds) {
        state.setRunFiles(targetStream, message.runId, message.rounds);
      } else {
        state.deleteRunFiles(targetStream, message.runId);
      }
    }

    if (targetStream === state.activeStream) {
      this._refreshOutputsForActiveRun();
    }
  }

  handleUpdateMissingOutputs(message) {
    const targetStream = this._getTargetStream(message);
    if (!targetStream) return;

    if (message.reset) {
      state.clearRunMissingOutputs(targetStream);
      return;
    }

    if (!message.runId) return;

    const hasRounds = message.rounds && Object.keys(message.rounds).length > 0;
    if (hasRounds) {
      state.setRunMissingOutputs(targetStream, message.runId, message.rounds);
    } else {
      state.deleteRunMissingOutputs(targetStream, message.runId);
    }
  }

  handleShowToolEditApproval(message) {
    if (message?.request) dom.approvalRequests.show(message.request);
  }

  handleResolveToolEditApproval(message) {
    if (message?.requestId) dom.approvalRequests.resolve(message.requestId);
  }

  handleUpdateToolEditApprovalState(message) {
    const bypassActive = Boolean(message?.bypassActive);
    state.approvalBypassActive = bypassActive;
    dom.approvalRequests.setSessionBypassActive(bypassActive);
    dom.followUpInput.setApprovalBypassState(bypassActive);
  }

  handleShowRetryRequest(message) {
    if (message?.request) dom.retryRequests.show(message.request);
  }

  handleResolveRetryRequest(message) {
    if (message?.streamId) dom.retryRequests.resolve(message.streamId);
  }

  /**
   * @param {{
   *   stream: string | null,
   *   instruction: import('../types').InstructionUpdate | null
   * }} message
   */
  handleUpdateInstruction(message) {
    const activeStream = state.activeStream || '';

    if (message.stream !== activeStream) {
      if (!activeStream && !message.stream) dom.instructionPanel.hide();
      return;
    }

    const text = message.instruction?.text ?? '';
    const metadata = message.instruction?.metadata;
    const sessionKind =
      message.sessionKind || state.activeSessionKind || 'workflow';
    const isToolUseAgent = sessionKind === 'toolUse';
    const hasText = typeof text === 'string' && text.trim();

    if (message.sessionKind) this._clearSessionKindState(sessionKind);
    state.activeSessionKind = sessionKind;

    // Resolve active run ID
    let activeRunId =
      state.getActiveRunId(activeStream) ||
      dom.runSelector.getActiveRunId() ||
      state.resolveActiveRunId(activeStream);
    if (activeRunId) state.setActiveRunId(activeStream, activeRunId);

    // Update run instruction state
    if (activeRunId) {
      if (hasText) {
        state.setRunInstruction(activeStream, activeRunId, { text, metadata });
      } else {
        state.clearRunInstruction(activeStream, activeRunId);
      }
      state.clearPendingInstruction(activeStream);
    }

    // Tool-use agents: render instruction as user message in log
    if (isToolUseAgent) {
      dom.instructionPanel.hide();
      state.clearPendingInstruction(activeStream);
      if (hasText)
        this._renderToolUseInstruction(activeStream, activeRunId, text);
      else this._refreshInstructionForActiveRun();
      return;
    }

    // Workflow agents: show in panel or as pending
    if (!activeRunId) {
      if (hasText) {
        state.setPendingInstruction(activeStream, { text, metadata });
        dom.instructionPanel.show(text, metadata);
      } else {
        state.clearPendingInstruction(activeStream);
        dom.instructionPanel.hide();
      }
      return;
    }

    this._refreshInstructionForActiveRun();
  }

  /**
   * Render instruction as user message in log for tool-use agents.
   */
  _renderToolUseInstruction(stream, runId, text) {
    const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    if (!logContent) return;

    const targetContentId = runId
      ? `${GROUP_DOM_IDS.CONTENT_PREFIX}${runId}`
      : null;
    const scope =
      (targetContentId && document.getElementById(targetContentId)) ||
      logContent;

    if (scope.querySelector('.user-message-container[data-instruction="true"]'))
      return;

    const userMessage = this._entryFormatter.format({
      id: `instruction-${stream}-${runId || 'default'}`,
      messageType: 'userMessage',
      text,
      timestamp: Date.now(),
      groupId: runId || undefined,
    });

    if (userMessage) {
      userMessage.dataset.instruction = 'true';
      scope.insertBefore(userMessage, scope.firstChild);
    }
  }

  handleDeleteStream(message) {
    if (!message.stream) {
      this._updatePlaceholderVisibility();
      return;
    }

    const deletingActiveStream = message.stream === state.activeStream;
    pendingLogUpdates.clear();
    state.removeStream(message.stream);
    state.streamStatuses.delete(message.stream);
    this._clearRunScopedState(message.stream);

    if (deletingActiveStream) {
      state.activeStream = '';
      state.lastRenderedStream = '';
      const groupIds = Array.from(state.taskGroups.getGroupMap().keys());
      state.toggleStates.clearSelection(groupIds);
      this._clearActivePanels();
    }

    this._updatePlaceholderVisibility();
  }

  handleDeleteAll() {
    pendingLogUpdates.clear();
    state.toggleStates.clearAll();
    state.clearStreams();
    state.activeStream = '';
    state.lastRenderedStream = '';
    this._clearRunScopedState(null);
    this._clearActivePanels();
    this._updatePlaceholderVisibility();
  }

  handleFollowUpTextPolished(message) {
    if (typeof message.text !== 'string') {
      return;
    }
    dom.followUpInput.applyPolishedText(message.text);
  }

  handleFollowUpTextTranscribed(message) {
    if (typeof message.text !== 'string') {
      dom.followUpInput.setRecording(false);
      return;
    }
    dom.followUpInput.insertTranscription(message.text);
    dom.followUpInput.setRecording(false);
  }

  handleRecordingStarted() {
    dom.followUpInput.setRecording(true);
  }

  handleRecordingStopped() {
    dom.followUpInput.setRecording(false);
  }

  handleRecordingError() {
    this.handleRecordingStopped();
  }

  /**
   * Handle UPDATE_TODOS command from extension host.
   * Updates the todo list display for the specified stream.
   * @param {{ stream: string, todos: Array<{content: string, status: string, activeForm: string}> }} message
   */
  handleUpdateTodos(message) {
    const { stream, todos } = message;
    if (!stream || !Array.isArray(todos)) {
      return;
    }

    // Always store todos in state for persistence
    state.setTodos(stream, todos);

    // Only update DOM if this is the active stream
    if (stream === state.activeStream) {
      dom.todoList.update(todos);
    }
  }

  /**
   * Handle UPDATE_QUEUED_FOLLOW_UPS command from extension host.
   * Updates the queued follow-ups display for the specified stream.
   * @param {{ stream: string, messages: string[] }} message
   */
  handleUpdateQueuedFollowUps(message) {
    const { stream, messages } = message;
    if (!stream || !Array.isArray(messages)) {
      return;
    }

    // Always store queued messages in state for persistence
    state.setQueuedFollowUps(stream, messages);

    // Only update DOM if this is the active stream
    if (stream === state.activeStream) {
      dom.queuedFollowUps.update(messages);
    }
  }
}

export const messageHandler = new ProgressViewMessageHandler();
