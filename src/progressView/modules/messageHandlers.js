// Local imports - progress view
import { COMMANDS, STATUS, ELEMENT_IDS } from './constants.js';
import { progressViewDomHandler, LogEntryFormatter } from './domHandlers.js';
import { createThemeHandlers } from './handlers/themeHandlers.js';
import { appendFormatted } from './utils.js';
// Local imports - log state
import { progressViewState } from './progressViewState.js';
import { BaseWebviewMessageHandler } from '@common/BaseWebviewMessageHandler.js';
import { vscode } from '@common/webviewContext.js';

// Session kind values match TypeScript AgentSessionKind enum
// No need to duplicate - we use the actual values from messages

// Create shorter aliases for internal use
const state = progressViewState;
const dom = progressViewDomHandler;

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
    this._entryFormatter = new LogEntryFormatter();
    this._handlers = {
      ...createThemeHandlers(),
      ...this._createHandlers(),
    };
  }

  /**
   * Toggle the placeholder based on active stream and log content
   */
  _updatePlaceholderVisibility() {
    const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    if (!state.activeStream && logContent.children.length === 0) {
      dom.placeholder.show();
    } else {
      dom.placeholder.hide();
    }
  }

  _createHandlers() {
    return {
      [COMMANDS.UPDATE_STREAMS]: (m) => this.handleUpdateStreams(m),
      [COMMANDS.UPDATE_LOGS]: (m) => this.handleUpdateLogs(m),
      [COMMANDS.CLEAR_LOGS]: () => this.handleClearLogs(),
      [COMMANDS.APPEND_LOG]: (m) => this.handleAppendLog(m),
      [COMMANDS.UPDATE_LOG]: (m) => this.handleUpdateLog(m),
      [COMMANDS.ADD_TASK_GROUP]: (m) => this.handleAddTaskGroup(m),
      [COMMANDS.UPDATE_TASK_GROUP]: (m) => this.handleUpdateTaskGroup(m),
      [COMMANDS.UPDATE_STATUS]: (m) => this.handleUpdateStatus(m),
      [COMMANDS.UPDATE_USAGE]: (m) => this.handleUpdateUsage(m),
      [COMMANDS.UPDATE_GROUP_USAGE]: (m) => this.handleUpdateGroupUsage(m),
      [COMMANDS.UPDATE_FILES]: (m) => this.handleUpdateFiles(m),
      [COMMANDS.UPDATE_MISSING_OUTPUTS]: (m) =>
        this.handleUpdateMissingOutputs(m),
      [COMMANDS.SHOW_TOOL_EDIT_APPROVAL]: (m) =>
        this.handleShowToolEditApproval(m),
      [COMMANDS.RESOLVE_TOOL_EDIT_APPROVAL]: (m) =>
        this.handleResolveToolEditApproval(m),
      [COMMANDS.UPDATE_INSTRUCTION]: (m) => this.handleUpdateInstruction(m),
      [COMMANDS.DELETE_STREAM]: (m) => this.handleDeleteStream(m),
      [COMMANDS.DELETE_ALL]: () => this.handleDeleteAll(),
      [COMMANDS.FOLLOW_UP_TEXT_POLISHED]: (m) =>
        this.handleFollowUpTextPolished(m),
      [COMMANDS.FOLLOW_UP_TEXT_TRANSCRIBED]: (m) =>
        this.handleFollowUpTextTranscribed(m),
      [COMMANDS.RECORDING_STARTED]: () => this.handleRecordingStarted(),
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
    message.streams.forEach((s) => {
      if (s.status) {
        state.streamStatuses.set(s.name, s.status);
      } else {
        state.streamStatuses.delete(s.name);
      }
      state.setExecutionIdAvailable(s.name, Boolean(s.executionId));
    });

    // Backend already sends filtered streams, no need to filter again
    const streams = message.streams || [];

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

    const container = document.getElementById(ELEMENT_IDS.FOLLOW_UP_CONTAINER);
    if (container) {
      container.classList.toggle('is-visible', isToolAgent);
      container.setAttribute('aria-hidden', isToolAgent ? 'false' : 'true');
    }

    dom.toolbar.render(sessionKind);

    const hasExecution = state.hasExecutionId(message.activeStream);
    dom.status.setExecutionIdAvailability(Boolean(hasExecution));

    // Update status based on whether there's an active stream
    if (!message.activeStream) {
      dom.status.update(STATUS.READY);
      dom.instructionPanel.hide();
    } else {
      const streamStatus = state.streamStatuses.get(message.activeStream);
      dom.status.update(streamStatus || STATUS.STOPPED);
    }
  }

  handleUpdateLogs(message) {
    const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    if (message.stream === state.activeStream) {
      dom.taskGroups.clear();
      state.taskGroups.clear();
      logContent.innerHTML = '';
      if (message.groups && message.groups.length > 0) {
        const parentGroups = message.groups.filter((g) => !g.parentGroupId);
        const childGroups = message.groups.filter((g) => g.parentGroupId);
        parentGroups
          .sort((a, b) => a.startTime - b.startTime)
          .forEach((g) => dom.taskGroups.addGroup(g));
        childGroups
          .sort((a, b) => a.startTime - b.startTime)
          .forEach((g) => dom.taskGroups.addGroup(g));
      }
      const sortedMessages = [...message.messages].sort(
        (a, b) => a.timestamp - b.timestamp,
      );
      sortedMessages.forEach((msg) => {
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

      // Recalculate cumulative usage after loading groups
      dom.usageSummary.update();
    }

    this._updatePlaceholderVisibility();
  }

  handleClearLogs() {
    const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    const groupIds = Array.from(state.taskGroups.getGroupMap().keys());
    dom.taskGroups.clear();
    state.taskGroups.clear();
    state.toggleStates.clearSelection(groupIds);
    if (logContent) {
      logContent.innerHTML = '';
    }

    this._updatePlaceholderVisibility();
  }

  handleAppendLog(message) {
    if (message.stream === state.activeStream) {
      const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
      const addedToGroup = dom.logEntries.append(message.logMessage);
      if (!addedToGroup) {
        const formatted = this._entryFormatter.format(message.logMessage);
        if (formatted instanceof HTMLElement) {
          // For thinking and scratchpad, auto-expand when live streaming
          const messageType = message.logMessage.messageType;
          if (messageType === 'thinking' || messageType === 'scratchpad') {
            formatted.setAttribute('open', '');
            const toggleIcon = formatted.querySelector('.toggle-icon');
            if (toggleIcon) {
              toggleIcon.className = 'codicon codicon-chevron-down toggle-icon';
            }
          }
        }
        appendFormatted(logContent, formatted);
      }
      scrollToBottom(logContent);
    }
  }

  handleUpdateLog(message) {
    if (message.stream === state.activeStream) {
      const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
      const updated = dom.logEntries.update(message.logMessage);
      if (!updated) {
        // Fallback: append as new log with proper group placement
        const addedToGroup = dom.logEntries.append(message.logMessage);
        if (!addedToGroup) {
          const formatted = this._entryFormatter.format(message.logMessage);
          if (formatted instanceof HTMLElement) {
            // For thinking and scratchpad, auto-expand when live streaming
            const messageType = message.logMessage.messageType;
            if (messageType === 'thinking' || messageType === 'scratchpad') {
              formatted.setAttribute('open', '');
              const toggleIcon = formatted.querySelector('.toggle-icon');
              if (toggleIcon) {
                toggleIcon.className =
                  'codicon codicon-chevron-down toggle-icon';
              }
            }
          }
          appendFormatted(logContent, formatted);
        }
        scrollToBottom(logContent);
      }
    }
  }

  handleAddTaskGroup(message) {
    if (message.stream === state.activeStream) {
      const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
      dom.taskGroups.addGroup(message.group);
      scrollToBottom(logContent);
    }
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
  }

  handleUpdateUsage(message) {
    dom.usageSummary.update(message.usage);
  }

  handleUpdateGroupUsage(message) {
    if (message.stream === state.activeStream) {
      dom.usageGroup.update({
        groupId: message.groupId,
        usage: message.usage,
      });
    }
  }

  handleUpdateFiles(message) {
    if (message.stream === state.activeStream) {
      dom.fileList.update(message.files);
    }
  }

  handleUpdateMissingOutputs(message) {
    // State persisted server-side - no direct DOM updates needed
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

    const payload = message.instruction;
    const text = payload?.text ?? '';

    if (!text.trim()) {
      dom.instructionPanel.hide();
      return;
    }

    const sessionKind = message.sessionKind || 'workflow';
    const isToolUseAgent = sessionKind === 'toolUse';

    if (isToolUseAgent) {
      // For Tool Use agents, show instruction as a user message in chat
      dom.instructionPanel.hide();

      const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
      if (logContent) {
        // Check if instruction message already exists
        const existingInstruction = logContent.querySelector(
          '.user-message-container[data-instruction="true"]',
        );
        if (!existingInstruction) {
          const userMessage = this._entryFormatter.format({
            id: `instruction-${activeStream}`,
            messageType: 'userMessage',
            text: text,
            timestamp: Date.now(),
            groupId: undefined,
          });

          if (userMessage) {
            userMessage.dataset.instruction = 'true';
            // Insert at the beginning of the log content
            if (logContent.firstChild) {
              logContent.insertBefore(userMessage, logContent.firstChild);
            } else {
              logContent.appendChild(userMessage);
            }
          }
        }
      }
    } else {
      // For Workflow agents, show in instruction panel
      const metadata = payload?.metadata ?? {};
      dom.instructionPanel.show(text, metadata);
    }
  }

  handleDeleteStream(message) {
    if (message.stream) {
      state.streamStatuses.delete(message.stream);
      state.clearExecutionIdAvailability(message.stream);
      if (message.stream === state.activeStream) {
        const groupIds = Array.from(state.taskGroups.getGroupMap().keys());
        state.toggleStates.clearSelection(groupIds);
        dom.instructionPanel.hide();
      }
    }
  }

  handleDeleteAll() {
    state.toggleStates.clearAll();
    state.resetExecutionIdAvailability();
    dom.instructionPanel.hide();
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

  handleRecordingError() {
    dom.followUpInput.setRecording(false);
  }
}

export const messageHandler = new ProgressViewMessageHandler();
