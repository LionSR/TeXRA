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

// Agent category values match TypeScript AgentCategory enum
// No need to duplicate - we use the actual values from messages

/**
 * ARCHITECTURAL NOTE: Task Groups have different semantics per agent category
 *
 * The "task group" abstraction is currently overloaded:
 *
 * - Workflow agents: Each group is a distinct "run" (user can switch between runs,
 *   only one visible at a time via run selector dropdown)
 *
 * - ToolUse agents: Each group is a conversation "turn" (user message → agent
 *   response with tool calls). All turns should always be visible as continuous
 *   conversation history.
 *
 * This semantic mismatch requires special handling throughout (checking isToolUse
 * before calling showRun). A cleaner design would separate these concepts:
 * - WorkflowRunManager for workflow agents (switching between runs)
 * - ConversationTurnManager for toolUse agents (append-only history)
 *
 * TODO: Consider refactoring to separate these concerns in a future PR.
 */

// Create shorter aliases for internal use
const state = progressViewState;
const dom = progressViewDomHandler;
const pendingLogUpdates = new Map();

// Create formatter instances

export class ProgressViewMessageHandler extends BaseWebviewMessageHandler {
  constructor() {
    super();
    this._entryFormatter = getSharedLogEntryFormatter();
    this._lastFollowupState = null;
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
   */
  _getActiveRunContext(runIdHint) {
    const stream = state.activeStream;
    if (!stream) return null;
    const runId = runIdHint ?? state.resolveActiveRunId(stream);
    return runId ? { stream, runId } : null;
  }

  /**
   * Refresh instruction panel for the active run.
   * @param {string} [runId] - Optional runId to use instead of resolving
   */
  _refreshInstructionForActiveRun(runId) {
    // Tool-use agents don't use instruction panel
    if (state.activeAgentCategory === 'toolUse')
      return dom.instructionPanel.hide();

    const ctx = this._getActiveRunContext(runId);
    if (!ctx) return dom.instructionPanel.hide();

    const instruction = state.getRunInstruction(ctx.stream, ctx.runId);
    instruction?.text
      ? dom.instructionPanel.show(instruction.text, instruction.metadata)
      : dom.instructionPanel.hide();
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
    const showRoundHeaders = state.activeAgentCategory !== 'toolUse';
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
    const contextState = state.activeStream
      ? state.getContextState(state.activeStream)
      : null;
    contextState
      ? dom.usageSummary.updateContextDisplay(contextState)
      : dom.usageSummary.clearContextDisplay();
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
   * Clear stale state when switching between agent categories.
   * Different categories have incompatible task group structures:
   * - Workflow agents create hierarchical task groups
   * - Tool-use agents don't create task groups at all
   * Stale groups from previous streams interfere with run ID resolution.
   *
   * NOTE: Log content is NOT cleared here. It's handled by handleUpdateLogs
   * with forceRebuild: true, which properly coordinates clearing with
   * re-rendering. Clearing here would cause data loss when UPDATE_LOGS
   * arrives with forceRebuild: false (same stream, incremental update).
   *
   * @param {string} newCategory - The new agent category being switched to
   * @returns {boolean} true if state was cleared
   */
  _clearAgentCategoryState(newCategory) {
    const shouldClear =
      newCategory !== state.activeAgentCategory && state.activeAgentCategory;
    if (shouldClear) {
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
    dom.followupSection.clear();
  }

  /**
   * Clear run-scoped state for a specific stream or all streams.
   * @param {string|null} stream - The stream to clear, or null to clear all
   */
  _clearRunScopedState(stream) {
    if (stream) {
      // Single stream: use batched clear for run-scoped data
      state.clearStreamRunData(stream);
      state.clearContextState(stream);
      state.clearExecutionIdAvailability(stream);
      state.clearTodos(stream);
      state.clearQueuedFollowUps(stream);
      state.clearFollowUpText(stream);
    } else {
      // All streams: individual clear methods that support null
      state.clearRunInstructions(null);
      state.clearRunFiles(null);
      state.clearRunMissingOutputs(null);
      state.clearRunUsage(null, null);
      state.clearContextState(null);
      state.resetExecutionIdAvailability();
      state.clearAllActiveRuns();
      state.clearAllTodos();
      state.clearAllQueuedFollowUps();
      state.clearAllFollowUpText();
    }
  }

  /**
   * Determine agent category from stream info with fallback to current state.
   * @param {Object|undefined} streamInfo - The active stream's info object
   * @returns {string} The agent category ('workflow' or 'toolUse')
   */
  _resolveAgentCategory(streamInfo) {
    if (!streamInfo) return state.activeAgentCategory || 'workflow';
    return (
      streamInfo.agentCategory ||
      streamInfo.uiTraits?.agentCategory ||
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
    setRadioGroupValue(radioGroup, state.agentCategoryFilter);
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
        console.warn(
          '[_renderLogMessage] Message has groupId but no container:',
          {
            messageType: msg.messageType,
            id: msg.id,
            groupId: msg.groupId,
          },
        );
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
   * Update run-scoped metadata (instructions, usage, files, missing outputs, context) from message.
   * Shared by handleUpdateLogs and _handleIncrementalUpdate to avoid duplication.
   */
  _updateRunMetadata(stream, message) {
    // Apply run-scoped metadata via iteration
    const runDataSources = [
      [message.runInstructions, state.setRunInstruction],
      [message.runUsage, state.setRunUsage],
      [message.runFiles, state.setRunFiles],
      [message.runMissingOutputs, state.setRunMissingOutputs],
    ];
    for (const [data, setter] of runDataSources) {
      if (!data) continue;
      for (const [runId, value] of Object.entries(data)) {
        if (runId) setter.call(state, stream, runId, value);
      }
    }

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
      [COMMANDS.SHOW_AGENT_PROPOSAL]:
        this.handleShowWorkflowProposal.bind(this),
      [COMMANDS.RESOLVE_AGENT_PROPOSAL]:
        this.handleResolveWorkflowProposal.bind(this),
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
      [COMMANDS.SET_FOLLOWUP_OPTIONS]: this.handleSetFollowupOptions.bind(this),
    };
  }

  handleUpdateStreams(message) {
    // Save follow-up text for the previous stream before switching
    const previousStream = state.activeStream;
    if (previousStream && previousStream !== message.activeStream) {
      dom.followUpInput.saveTextForStream(previousStream);
    }

    state.activeStream = message.activeStream;
    // Update filter if message specifies a different value (and not a pending local change)
    if (
      !state.pendingFilterUpdate &&
      message.agentFilter !== undefined &&
      message.agentFilter !== state.agentCategoryFilter
    ) {
      state.agentCategoryFilter = message.agentFilter;
    }
    state.pendingFilterUpdate = false;
    state.resetExecutionIdAvailability();

    // Process streams - preserve ERROR status when omitted
    const streams = (message.streams ?? []).map((s) => {
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
    const category = this._resolveAgentCategory(activeStreamInfo);
    const isToolAgent = category === 'toolUse';

    // Only clear state if we have confirmed stream info for the category change
    if (activeStreamInfo) {
      this._clearAgentCategoryState(category);
    }
    state.activeAgentCategory = category;

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

    // YOLO state is sent by backend via updateToolEditApprovalState message
    // No need to restore from frontend cache here

    dom.approvalRequests.setActiveStream(message.activeStream, isToolAgent);
    dom.retryRequests.setActiveStream(message.activeStream, isToolAgent);
    dom.workflowProposals.setActiveStream(message.activeStream, isToolAgent);

    dom.toolbar.render(category);

    const hasExecution = state.hasExecutionId(message.activeStream);
    dom.status.setExecutionIdAvailability(Boolean(hasExecution));

    // Update status based on whether there's an active stream
    if (!message.activeStream) {
      dom.status.update(STREAM_STATUS.READY);
      this._clearActivePanels();
      const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
      if (logContent) logContent.innerHTML = '';
      state.lastRenderedStream = '';
      state.clearRunInstructions();
      state.clearAllActiveRuns();
      state.clearAllPendingInstructions();
      state.clearAllTodos();
      state.clearAllQueuedFollowUps();
      state.clearAllFollowUpText();
    } else {
      // NOTE: Content clearing is handled by handleUpdateLogs which always follows.
      // Backend always sends UPDATE_LOGS after UPDATE_STREAMS (even for empty streams).
      // Clearing here would be redundant - we'd clear twice.

      const streamStatus = state.streamStatuses.get(message.activeStream);
      dom.status.update(streamStatus || STREAM_STATUS.STOPPED);
      dom.todoList.update(state.getTodos(message.activeStream) ?? []);
      dom.queuedFollowUps.update(
        state.getQueuedFollowUps(message.activeStream) ?? [],
      );
      this._focusFollowUpIfWaiting(streamStatus);
    }

    // NOTE: _refreshActiveRunPanels() NOT called here - UPDATE_LOGS always follows
    // and calls it with the correct activeRunId. Calling here would be redundant.
    this._updateFollowupSection();
  }

  handleUpdateLogs(message) {
    if (!this._isActiveStream(message)) {
      this._updatePlaceholderVisibility();
      return;
    }

    const logMessages = message.messages ?? [];

    // Sort messages by timestamp to ensure chronological order
    // Backend may send messages in arbitrary order during reload
    const sortedMessages = [...logMessages].sort((a, b) => {
      const timeA = a.timestamp ?? 0;
      const timeB = b.timestamp ?? 0;
      return timeA - timeB;
    });

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
    const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    const previousRunId = state.getActiveRunId(message.stream);
    pendingLogUpdates.clear();
    dom.taskGroups.clear();
    state.taskGroups.clear();
    state.clearStreamRunData(message.stream); // Batched clear of all run-scoped data
    logContent.innerHTML = '';
    const groups = message.groups ?? [];

    // Always update run metadata (instructions, usage, files) regardless of groups
    // Tool-use agents don't create task groups but still have usage data
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

    // Batch all messages via DocumentFragment to avoid layout thrashing
    const ungroupedFragment = document.createDocumentFragment();
    const groupedFragments = new Map(); // groupId → fragment

    for (const msg of sortedMessages) {
      const formatted = this._entryFormatter.format(msg);
      if (!formatted) continue;

      if (msg.groupId) {
        let frag = groupedFragments.get(msg.groupId);
        if (!frag) {
          frag = document.createDocumentFragment();
          groupedFragments.set(msg.groupId, frag);
        }
        appendFormatted(frag, formatted);
      } else {
        appendFormatted(ungroupedFragment, formatted);
      }
    }

    // Append grouped messages to their containers (fallback to main log if group missing)
    for (const [groupId, frag] of groupedFragments) {
      const container = dom.logEntries.getGroupContainer(groupId);
      if (container) {
        container.appendChild(frag);
      } else {
        // Group container not found - append to main log as fallback
        logContent.appendChild(frag);
      }
    }

    // Append ungrouped messages to main log
    if (ungroupedFragment.childNodes.length > 0) {
      logContent.appendChild(ungroupedFragment);
    }
    scrollToBottom(logContent);

    // Use validated run ID from state (set earlier via setActiveRunId after validation)
    const activeRunId = state.resolveActiveRunId(message.stream);
    this._refreshActiveRunPanels(activeRunId);

    // Update lastRenderedStream AFTER successful render.
    // This is the single source of truth for stream switch detection.
    state.lastRenderedStream = message.stream;

    this._updatePlaceholderVisibility();
    // Update followup section - files may have been loaded via runFiles
    this._updateFollowupSection();
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
    // Update followup section - files may have changed
    this._updateFollowupSection();
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
    if (!stream) return;

    // Validate status against known values
    if (status && !Object.values(STREAM_STATUS).includes(status)) {
      console.debug(
        `[updateStreamStatus] Invalid status "${status}" for stream: ${stream}`,
      );
      return;
    }

    // Update state (single source of truth) - streamStatuses.set handles READY as delete
    state.streamStatuses.set(stream, status);
    dom.streamTabs.updateStreamStatus(stream, status, lastTimestamp);

    // Update main status indicator if this is the active stream
    if (stream === state.activeStream) {
      dom.status.update(status || STREAM_STATUS.STOPPED);
      this._focusFollowUpIfWaiting(status);
      // Update followup section when status changes (may become visible when stopped)
      this._updateFollowupSection();
    }
  }

  /**
   * Handle full usage update (replaces all run usage for a stream).
   *
   * Always saves state regardless of active stream to prevent race conditions
   * where messages arrive before UPDATE_STREAMS sets state.activeStream.
   */
  handleUpdateUsage(message) {
    const targetStream = this._getTargetStream(message);
    if (!targetStream) {
      return;
    }

    // Always save state - ensures data available when switching streams
    state.clearRunUsage(targetStream);
    const usageByRun = message.usageByRun ?? {};
    Object.entries(usageByRun).forEach(([runId, usage]) => {
      state.setRunUsage(targetStream, runId, usage);
    });

    // Only refresh display for active stream
    if (targetStream === state.activeStream) {
      this._refreshUsageForActiveRun();
    }
  }

  /**
   * Handle incremental usage update for a single run.
   * More efficient than handleUpdateUsage during streaming.
   *
   * Always saves state regardless of active stream to prevent race conditions
   * where messages arrive before UPDATE_STREAMS sets state.activeStream.
   */
  handleUpdateRunUsage(message) {
    const targetStream = this._getTargetStream(message);
    if (!targetStream || !message.runId) {
      return;
    }

    // Always save state - ensures data available when switching streams
    state.setRunUsage(targetStream, message.runId, message.usage);

    // Only refresh display for active stream
    if (targetStream === state.activeStream) {
      this._refreshUsageForActiveRun();
    }
  }

  /**
   * Handle context state update (input tokens vs context window).
   * Updates the context utilization display in the footer.
   *
   * Always saves state to frontend cache regardless of active stream.
   * This prevents race conditions where UPDATE_CONTEXT_STATE arrives
   * before UPDATE_STREAMS has set state.activeStream.
   */
  handleUpdateContextState(message) {
    const targetStream = this._getTargetStream(message);
    if (!targetStream || !message.contextState) {
      return;
    }

    // Always save to state cache - ensures data is available when
    // switching streams even if display update was skipped
    state.setContextState(targetStream, message.contextState);

    // Update the context display only for the active stream
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
      hasRounds
        ? state.setRunFiles(targetStream, message.runId, message.rounds)
        : state.deleteRunFiles(targetStream, message.runId);
    }

    if (targetStream === state.activeStream) {
      this._refreshOutputsForActiveRun();
      // Update followup section when files change (affects visibility)
      this._updateFollowupSection();
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
    hasRounds
      ? state.setRunMissingOutputs(targetStream, message.runId, message.rounds)
      : state.deleteRunMissingOutputs(targetStream, message.runId);
  }

  handleShowToolEditApproval(message) {
    if (message?.request) dom.approvalRequests.show(message.request);
  }

  handleResolveToolEditApproval(message) {
    if (message?.requestId) dom.approvalRequests.resolve(message.requestId);
  }

  handleUpdateToolEditApprovalState(message) {
    const stream = message?.stream;
    const bypassActive = Boolean(message?.bypassActive);

    // Update UI if this is for the active stream
    // Backend is single source of truth - no local caching
    if (stream === state.activeStream) {
      dom.followUpInput.setApprovalBypassState(bypassActive);
    }
  }

  handleShowRetryRequest(message) {
    if (message?.request) dom.retryRequests.show(message.request);
  }

  handleResolveRetryRequest(message) {
    if (message?.streamId) dom.retryRequests.resolve(message.streamId);
  }

  handleShowWorkflowProposal(message) {
    if (message?.proposal) dom.workflowProposals.show(message.proposal);
  }

  handleResolveWorkflowProposal(message) {
    if (message?.proposalId) dom.workflowProposals.resolve(message.proposalId);
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
    const category =
      message.agentCategory || state.activeAgentCategory || 'workflow';
    const isToolUseAgent = category === 'toolUse';
    const hasText = typeof text === 'string' && text.trim();

    if (message.agentCategory) this._clearAgentCategoryState(category);
    state.activeAgentCategory = category;

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

  /**
   * Handle SET_FOLLOWUP_OPTIONS command from extension host.
   * Updates the followup section dropdowns with pre-built HTML options.
   * @param {{ workflowAgentsHtml: string, toolUseAgentsHtml: string, modelOptionsHtml: string, defaultMergeModel: string }} message
   */
  handleSetFollowupOptions(message) {
    const {
      workflowAgentsHtml,
      toolUseAgentsHtml,
      modelOptionsHtml,
      defaultMergeModel,
    } = message;
    dom.followupSection?.setOptions?.({
      workflowAgentsHtml,
      toolUseAgentsHtml,
      modelOptionsHtml,
      defaultMergeModel,
    });
  }

  /**
   * Update followup section visibility based on current stream state.
   * Called when stream status changes or streams are updated.
   * Skips update if nothing relevant changed.
   */
  _updateFollowupSection() {
    const activeStream = state.activeStream;
    if (!activeStream) {
      if (this._lastFollowupState !== null) {
        this._lastFollowupState = null;
        dom.followupSection?.updateForStream?.(null);
      }
      return;
    }

    const streamStatus = state.streamStatuses.get(activeStream);
    const category = state.activeAgentCategory || 'workflow';
    const agentName = activeStream.split('@')[0] || activeStream;

    const runId = state.resolveActiveRunId(activeStream);
    const instruction = runId
      ? state.getRunInstruction(activeStream, runId)
      : null;
    const instructionPreview = instruction?.text
      ? instruction.text.slice(0, 100) +
        (instruction.text.length > 100 ? '...' : '')
      : null;

    // Count files in single pass (also determines hasOutputFiles)
    const files = runId ? state.getRunFiles(activeStream, runId) : null;
    let fileCount = 0;
    if (files) {
      for (const roundFiles of Object.values(files)) {
        if (Array.isArray(roundFiles)) fileCount += roundFiles.length;
      }
    }

    // Skip if nothing changed (use \0 separator to avoid collision with user content)
    const key = [activeStream, streamStatus, category, fileCount, instructionPreview ?? ''].join('\0');
    if (key === this._lastFollowupState) return;
    this._lastFollowupState = key;

    dom.followupSection?.updateForStream?.({
      agentCategory: category,
      status: streamStatus,
      hasOutputFiles: fileCount > 0,
      agentName,
      instructionPreview,
      fileCount,
    });
  }
}

export const messageHandler = new ProgressViewMessageHandler();
