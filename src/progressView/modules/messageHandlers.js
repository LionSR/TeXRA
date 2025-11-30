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
import { getSharedLogEntryFormatter } from './formatters.js';
// Local imports - log state
import { progressViewState } from './progressViewState.js';
import { BaseWebviewMessageHandler } from '@common/BaseWebviewMessageHandler.js';
import { vscode } from '@common/webviewContext.js';

// Session kind values match TypeScript AgentSessionKind enum
// No need to duplicate - we use the actual values from messages

// Create shorter aliases for internal use
const state = progressViewState;
const dom = progressViewDomHandler;
const pendingLogUpdates = new Map();

function scrollToBottom(element) {
  if (!element) {
    return;
  }

  if (
    typeof element.scrollPos === 'number' &&
    typeof element.scrollMax === 'number'
  ) {
    element.scrollPos = element.scrollMax;
    return;
  }

  if ('scrollTop' in element && 'scrollHeight' in element) {
    element.scrollTop = element.scrollHeight;
  }
}

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
    this._refreshInstructionForActiveRun();
    this._refreshOutputsForActiveRun();
    this._refreshUsageForActiveRun();
  }

  _refreshInstructionForActiveRun() {
    if (state.activeSessionKind === 'toolUse') {
      dom.instructionPanel.hide();
      return;
    }

    const stream = state.activeStream || null;
    const activeRunId = state.resolveActiveRunId(stream);
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

  _refreshOutputsForActiveRun() {
    const stream = state.activeStream || null;
    const activeRunId = state.resolveActiveRunId(stream);
    const filesByRound = activeRunId
      ? state.getRunFiles(stream, activeRunId) || {}
      : {};
    dom.fileList.update(filesByRound);
  }

  _refreshUsageForActiveRun() {
    dom.usageSummary.update();
  }

  _createHandlers() {
    return {
      [COMMANDS.UPDATE_STREAMS]: (m) => this.handleUpdateStreams(m),
      [COMMANDS.UPDATE_LOGS]: (m) => this.handleUpdateLogs(m),
      [COMMANDS.APPEND_LOG]: (m) => this.handleAppendLog(m),
      [COMMANDS.UPDATE_LOG]: (m) => this.handleUpdateLog(m),
      [COMMANDS.ADD_TASK_GROUP]: (m) => this.handleAddTaskGroup(m),
      [COMMANDS.UPDATE_TASK_GROUP]: (m) => this.handleUpdateTaskGroup(m),
      [COMMANDS.UPDATE_STATUS]: (m) => this.handleUpdateStatus(m),
      [COMMANDS.UPDATE_USAGE]: (m) => this.handleUpdateUsage(m),
      [COMMANDS.UPDATE_FILES]: (m) => this.handleUpdateFiles(m),
      [COMMANDS.UPDATE_MISSING_OUTPUTS]: (m) =>
        this.handleUpdateMissingOutputs(m),
      [COMMANDS.SHOW_TOOL_EDIT_APPROVAL]: (m) =>
        this.handleShowToolEditApproval(m),
      [COMMANDS.RESOLVE_TOOL_EDIT_APPROVAL]: (m) =>
        this.handleResolveToolEditApproval(m),
      [COMMANDS.UPDATE_TOOL_EDIT_APPROVAL_STATE]: (m) =>
        this.handleUpdateToolEditApprovalState(m),
      [COMMANDS.SHOW_RETRY_REQUEST]: (m) => this.handleShowRetryRequest(m),
      [COMMANDS.RESOLVE_RETRY_REQUEST]: (m) =>
        this.handleResolveRetryRequest(m),
      [COMMANDS.UPDATE_INSTRUCTION]: (m) => this.handleUpdateInstruction(m),
      [COMMANDS.DELETE_STREAM]: (m) => this.handleDeleteStream(m),
      [COMMANDS.DELETE_ALL]: () => this.handleDeleteAll(),
      [COMMANDS.FOLLOW_UP_TEXT_POLISHED]: (m) =>
        this.handleFollowUpTextPolished(m),
      [COMMANDS.FOLLOW_UP_TEXT_TRANSCRIBED]: (m) =>
        this.handleFollowUpTextTranscribed(m),
      [COMMANDS.RECORDING_STARTED]: () => this.handleRecordingStarted(),
      [COMMANDS.RECORDING_STOPPED]: () => this.handleRecordingStopped(),
      [COMMANDS.RECORDING_ERROR]: () => this.handleRecordingError(),
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
    // Preserve existing statuses when updates omit them so errored streams
    // remain marked as error instead of reverting to stopped
    const streams = (message.streams || []).map((s) => {
      const status =
        s.status !== undefined ? s.status : state.streamStatuses.get(s.name);
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
    const sessionKind =
      activeStreamInfo?.agentSessionKind ||
      activeStreamInfo?.uiTraits?.sessionKind ||
      'workflow'; // Default fallback
    const isToolAgent = sessionKind === 'toolUse';

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
      state.clearRunInstructions();
      state.clearAllActiveRuns();
      state.clearAllPendingInstructions();
    } else {
      const streamStatus = state.streamStatuses.get(message.activeStream);
      dom.status.update(streamStatus || STREAM_STATUS.STOPPED);
    }

    this._refreshInstructionForActiveRun();
    this._refreshUsageForActiveRun();
  }

  handleUpdateLogs(message) {
    const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    if (message.stream === state.activeStream) {
      pendingLogUpdates.clear();
      dom.taskGroups.clear();
      state.taskGroups.clear();
      state.clearRunInstructions(message.stream);
      state.clearRunFiles(message.stream);
      state.clearPendingInstruction(state.activeStream);
      const previousRunId = state.getActiveRunId(message.stream);
      state.clearActiveRun(message.stream);
      logContent.innerHTML = '';
      const groups = message.groups || [];
      if (groups.length > 0) {
        const parentGroups = groups.filter((g) => !g.parentGroupId);
        dom.runSelector.setRuns(parentGroups);
        dom.taskGroups.renderInitial(groups);

        if (message.runInstructions) {
          Object.entries(message.runInstructions).forEach(
            ([runId, instruction]) => {
              if (runId) {
                state.setRunInstruction(message.stream, runId, instruction);
              }
            },
          );
        }

        if (message.runUsage) {
          Object.entries(message.runUsage).forEach(([runId, usage]) => {
            state.setRunUsage(message.stream, runId, usage);
          });
        }

        if (message.runFiles) {
          Object.entries(message.runFiles).forEach(([runId, filesByRound]) => {
            if (runId) {
              state.setRunFiles(message.stream, runId, filesByRound);
            }
          });
        }

        if (parentGroups.length > 0) {
          const runIds = parentGroups.map((group) => group.id);
          const preferredRun =
            message.activeRunId && runIds.includes(message.activeRunId)
              ? message.activeRunId
              : previousRunId && runIds.includes(previousRunId)
                ? previousRunId
                : runIds[runIds.length - 1];
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
      const logMessages = message.messages || [];
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

      this._refreshInstructionForActiveRun();
      this._refreshOutputsForActiveRun();
      this._refreshUsageForActiveRun();
    }

    this._updatePlaceholderVisibility();
  }

  handleAppendLog(message) {
    if (message.stream === state.activeStream) {
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
    if (message.stream === state.activeStream) {
      const updated = dom.logEntries.update(message.logMessage);
      if (!updated) {
        const logId = message.logMessage?.id;
        if (logId) {
          const existingUpdate = pendingLogUpdates.get(logId) || {};
          pendingLogUpdates.set(logId, {
            ...existingUpdate,
            ...message.logMessage,
          });
        }
      }
    }
  }

  handleAddTaskGroup(message) {
    if (message.stream === state.activeStream) {
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
        this._refreshInstructionForActiveRun();
        this._refreshOutputsForActiveRun();
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

  handleUpdateUsage(message) {
    if (message.stream && message.stream !== state.activeStream) {
      return;
    }

    const targetStream = message.stream || state.activeStream || null;
    if (!targetStream) {
      return;
    }

    state.clearRunUsage(targetStream);
    const usageByRun = message.usageByRun || {};
    Object.entries(usageByRun).forEach(([runId, usage]) => {
      state.setRunUsage(targetStream, runId, usage);
    });
    this._refreshUsageForActiveRun();
  }

  handleUpdateFiles(message) {
    const targetStream = message.stream || state.activeStream || null;
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
    const targetStream = message.stream || state.activeStream || null;
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
      if (deletingActiveStream) {
        state.activeStream = '';
        const groupIds = Array.from(state.taskGroups.getGroupMap().keys());
        state.toggleStates.clearSelection(groupIds);
        dom.instructionPanel.hide();
        dom.runSelector.clear();
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
    dom.runSelector.clear();
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
}

export const messageHandler = new ProgressViewMessageHandler();
