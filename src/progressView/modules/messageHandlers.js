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
import { scrollToBottom } from '@common/domUtils.js';

// Session kind values match TypeScript AgentSessionKind enum
// No need to duplicate - we use the actual values from messages

// Create shorter aliases for internal use
const state = progressViewState;
const dom = progressViewDomHandler;
const pendingLogUpdates = new Map();

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
   * Refresh instruction panel for the active run.
   * @param {string} [runId] - Optional runId to use instead of resolving
   */
  _refreshInstructionForActiveRun(runId) {
    if (state.activeSessionKind === 'toolUse') {
      dom.instructionPanel.hide();
      return;
    }

    const stream = state.activeStream || null;
    const activeRunId = runId ?? state.resolveActiveRunId(stream);
    if (!activeRunId) {
      dom.instructionPanel.hide();
      return;
    }

    const instruction = state.getRunInstruction(stream, activeRunId);
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
    const stream = state.activeStream || null;
    const activeRunId = runId ?? state.resolveActiveRunId(stream);
    const filesByRound = activeRunId
      ? (state.getRunFiles(stream, activeRunId) ?? {})
      : {};
    // Hide round headers for tool-use agents where round numbers don't have meaning
    const showRoundHeaders = state.activeSessionKind !== 'toolUse';
    dom.fileList.update(filesByRound, { showRoundHeaders });
  }

  _refreshUsageForActiveRun() {
    dom.usageSummary.update();
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
   */
  _clearSessionKindState(newSessionKind) {
    if (newSessionKind !== state.activeSessionKind && state.activeSessionKind) {
      state.taskGroups.clear();
      dom.taskGroups.clear();
    }
  }

  /**
   * Update run-scoped metadata (instructions, usage, files) from message.
   * Shared by handleUpdateLogs and _handleIncrementalUpdate to avoid duplication.
   * @param {string} stream - The stream to update
   * @param {Object} message - Message containing runInstructions, runUsage, runFiles
   */
  _updateRunMetadata(stream, message) {
    if (message.runInstructions) {
      Object.entries(message.runInstructions).forEach(
        ([runId, instruction]) => {
          if (runId) {
            state.setRunInstruction(stream, runId, instruction);
          }
        },
      );
    }

    if (message.runUsage) {
      Object.entries(message.runUsage).forEach(([runId, usage]) => {
        state.setRunUsage(stream, runId, usage);
      });
    }

    if (message.runFiles) {
      Object.entries(message.runFiles).forEach(([runId, filesByRound]) => {
        if (runId) {
          state.setRunFiles(stream, runId, filesByRound);
        }
      });
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
    try {
      state.activeStream = message.activeStream;
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
    // Preserve ERROR status when updates omit status, so errored streams
    // remain marked as error instead of reverting to stopped. Other statuses
    // (like RUNNING) should not be preserved when omitted, as undefined means
    // the stream has completed (READY status is deleted from the status map).
    const streams = (message.streams ?? []).map((s) => {
      let status = s.status;
      if (status === undefined) {
        const cachedStatus = state.streamStatuses.get(s.name);
        // Only preserve ERROR status; other statuses should not persist
        status =
          cachedStatus === STREAM_STATUS.ERROR ? cachedStatus : undefined;
      }
      if (status) {
        state.streamStatuses.set(s.name, status);
      } else {
        state.streamStatuses.delete(s.name);
      }
      state.setExecutionIdAvailable(s.name, Boolean(s.executionId));
      return { ...s, status };
    });

    state.setStreams(streams.map((s) => s.name));

    dom.streamTabs.update(streams, message.activeStream);

    // Update agent filter radio group selection
    const radioGroup = document.getElementById(
      ELEMENT_IDS.AGENT_FILTER_CONTAINER,
    );
    if (radioGroup) {
      radioGroup.value = state.agentTypeFilter;
      // Also update the checked state on individual radio buttons
      radioGroup.querySelectorAll('vscode-radio').forEach((radio) => {
        const isActive = radio.value === state.agentTypeFilter;
        radio.checked = isActive;
        radio.setAttribute('aria-checked', isActive ? 'true' : 'false');
        radio.toggleAttribute('checked', isActive);
      });
    }

    this._updatePlaceholderVisibility();

    const activeStreamInfo = streams.find(
      (s) => s.name === message.activeStream,
    );
    // Only determine session kind if we have stream info - avoid false 'workflow' default
    // that would incorrectly clear tool-use log content
    const sessionKind = activeStreamInfo
      ? activeStreamInfo.agentSessionKind ||
        activeStreamInfo.uiTraits?.sessionKind ||
        'workflow'
      : state.activeSessionKind || 'workflow';
    const isToolAgent = sessionKind === 'toolUse';

    // Only clear session state if we have confirmed stream info for the session kind change
    // This prevents clearing log content when stream info is temporarily unavailable
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
      state.clearRunInstructions();
      state.clearAllActiveRuns();
      state.clearAllPendingInstructions();
      state.clearAllTodos();
      state.clearAllQueuedFollowUps();
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

    this._refreshInstructionForActiveRun();
    this._refreshUsageForActiveRun();
    this._refreshOutputsForActiveRun();
  }

  handleUpdateLogs(message) {
    if (!this._isActiveStream(message)) {
      this._updatePlaceholderVisibility();
      return;
    }

    // forceRebuild is now always a boolean from backend:
    // - false: Incremental update only (same stream, metadata changes)
    // - true: Full DOM rebuild (stream switch, data deletion, first load)
    if (!message.forceRebuild) {
      this._handleIncrementalUpdate(message);
      this._updatePlaceholderVisibility();
      return;
    }

    // Full rebuild path
    const logMessages = message.messages ?? [];
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
        const runIds = parentGroups.map((group) => group.id);
        const preferredRun =
          message.activeRunId && runIds.includes(message.activeRunId)
            ? message.activeRunId
            : previousRunId && runIds.includes(previousRunId)
              ? previousRunId
              : runIds.at(-1);
        state.setActiveRunId(message.stream, preferredRun);
        dom.runSelector.setActiveRun(preferredRun);
        dom.taskGroups.showRun(preferredRun);
      } else {
        dom.taskGroups.showRun(null);
      }

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
    logMessages.forEach((msg) => {
      if (msg.groupId) {
        if (!dom.logEntries.append(msg)) {
          const formatted = this._entryFormatter.format(msg);
          appendFormatted(logContent, formatted);
        }
      } else {
        const formatted = this._entryFormatter.format(msg);
        appendFormatted(logContent, formatted);
      }
    });
    scrollToBottom(logContent);

    // Use validated run ID from state (set earlier via setActiveRunId after validation)
    const activeRunId = state.resolveActiveRunId(message.stream);
    this._refreshInstructionForActiveRun(activeRunId);
    this._refreshOutputsForActiveRun(activeRunId);
    this._refreshUsageForActiveRun();

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
    this._refreshInstructionForActiveRun(activeRunId);
    this._refreshOutputsForActiveRun(activeRunId);
    this._refreshUsageForActiveRun();
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
      this.usageSummary?.updateContextDisplay?.(message.contextState);
    }
  }

  handleUpdateFiles(message) {
    const targetStream = this._getTargetStream(message);
    if (!targetStream) {
      return;
    }

    if (message.reset) {
      state.clearRunFiles(targetStream);
      if (targetStream === state.activeStream) {
        this._refreshOutputsForActiveRun();
      }
      return;
    }

    const runId = message.runId;
    if (!runId) {
      return;
    }

    const rounds = message.rounds;
    if (!rounds || Object.keys(rounds).length === 0) {
      state.deleteRunFiles(targetStream, runId);
    } else {
      state.setRunFiles(targetStream, runId, rounds);
    }

    if (targetStream === state.activeStream) {
      this._refreshOutputsForActiveRun();
    }
  }

  handleUpdateMissingOutputs(message) {
    const targetStream = this._getTargetStream(message);
    if (!targetStream) {
      return;
    }

    if (message.reset) {
      state.clearRunMissingOutputs(targetStream);
      return;
    }

    const runId = message.runId;
    if (!runId) {
      return;
    }

    const rounds = message.rounds;
    if (!rounds || Object.keys(rounds).length === 0) {
      state.deleteRunMissingOutputs(targetStream, runId);
    } else {
      state.setRunMissingOutputs(targetStream, runId, rounds);
    }
  }

  handleShowToolEditApproval(message) {
    if (!message || !message.request) {
      return;
    }
    dom.approvalRequests.show(message.request);
  }

  handleResolveToolEditApproval(message) {
    if (!message || !message.requestId) {
      return;
    }
    dom.approvalRequests.resolve(message.requestId);
  }

  handleUpdateToolEditApprovalState(message) {
    const bypassActive = Boolean(message?.bypassActive);
    state.approvalBypassActive = bypassActive;
    dom.approvalRequests.setSessionBypassActive(bypassActive);
    dom.followUpInput.setApprovalBypassState(bypassActive);
  }

  handleShowRetryRequest(message) {
    if (!message || !message.request) {
      return;
    }
    dom.retryRequests.show(message.request);
  }

  handleResolveRetryRequest(message) {
    if (!message || !message.streamId) {
      return;
    }
    dom.retryRequests.resolve(message.streamId);
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
      if (!activeStream && !message.stream) {
        dom.instructionPanel.hide();
      }
      return;
    }

    const payload = message.instruction || null;
    const text = payload?.text ?? '';
    const metadata = payload?.metadata;
    const sessionKind =
      message.sessionKind || state.activeSessionKind || 'workflow';
    const isToolUseAgent = sessionKind === 'toolUse';

    // Only clear session state if message explicitly provides session kind
    // This prevents clearing log content when session kind is derived from state fallback
    if (message.sessionKind) {
      this._clearSessionKindState(sessionKind);
    }
    state.activeSessionKind = sessionKind;

    let activeRunId = state.getActiveRunId(activeStream);
    if (!activeRunId) {
      activeRunId =
        dom.runSelector.getActiveRunId() ||
        state.resolveActiveRunId(activeStream);
      if (activeRunId) {
        state.setActiveRunId(activeStream, activeRunId);
      }
    }

    if (activeRunId) {
      if (typeof text === 'string' && text.trim()) {
        state.setRunInstruction(activeStream, activeRunId, {
          text,
          metadata,
        });
      } else {
        state.clearRunInstruction(activeStream, activeRunId);
      }
      state.clearPendingInstruction(activeStream);
    }

    if (isToolUseAgent) {
      dom.instructionPanel.hide();
      state.clearPendingInstruction(activeStream);

      if (!text || !text.trim()) {
        this._refreshInstructionForActiveRun();
        return;
      }

      const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
      if (logContent) {
        const targetContentId = activeRunId
          ? `${GROUP_DOM_IDS.CONTENT_PREFIX}${activeRunId}`
          : null;
        const targetContainer = targetContentId
          ? document.getElementById(targetContentId)
          : logContent;
        const scope = targetContainer || logContent;

        const existingInstruction = scope.querySelector(
          '.user-message-container[data-instruction="true"]',
        );

        if (!existingInstruction) {
          const userMessage = this._entryFormatter.format({
            id: `instruction-${activeStream}-${activeRunId || 'default'}`,
            messageType: 'userMessage',
            text,
            timestamp: Date.now(),
            groupId: activeRunId || undefined,
          });

          if (userMessage) {
            userMessage.dataset.instruction = 'true';
            if (scope.firstChild) {
              scope.insertBefore(userMessage, scope.firstChild);
            } else {
              scope.appendChild(userMessage);
            }
          }
        }
      }

      return;
    }

    if (!activeRunId) {
      if (typeof text === 'string' && text.trim()) {
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

  handleDeleteStream(message) {
    if (message.stream) {
      const deletingActiveStream = message.stream === state.activeStream;
      pendingLogUpdates.clear();
      state.removeStream(message.stream);
      state.streamStatuses.delete(message.stream);
      state.clearExecutionIdAvailability(message.stream);
      state.clearActiveRun(message.stream);
      state.clearRunInstructions(message.stream);
      state.clearRunFiles(message.stream);
      state.clearRunMissingOutputs(message.stream);
      state.clearRunUsage(message.stream);
      state.clearTodos(message.stream);
      state.clearQueuedFollowUps(message.stream);
      state.clearContextState(message.stream);
      if (deletingActiveStream) {
        state.activeStream = '';
        const groupIds = Array.from(state.taskGroups.getGroupMap().keys());
        state.toggleStates.clearSelection(groupIds);
        dom.instructionPanel.hide();
        dom.runSelector.clear();
        dom.todoList.clear();
        dom.queuedFollowUps.clear();
        dom.fileList.clear();
        dom.usageSummary?.clearContextDisplay?.();
      }
    }

    this._updatePlaceholderVisibility();
  }

  handleDeleteAll() {
    pendingLogUpdates.clear();
    state.toggleStates.clearAll();
    state.resetExecutionIdAvailability();
    state.clearStreams();
    state.activeStream = '';
    dom.instructionPanel.hide();
    state.clearRunInstructions();
    state.clearRunFiles();
    state.clearRunMissingOutputs();
    state.clearAllActiveRuns();
    state.clearAllTodos();
    state.clearAllQueuedFollowUps();
    state.clearContextState(); // Clear all context state entries
    dom.runSelector.clear();
    dom.todoList.clear();
    dom.queuedFollowUps.clear();
    dom.fileList.clear();
    dom.usageSummary?.clearContextDisplay?.();
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
    dom.followUpInput.setRecording(false);
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
