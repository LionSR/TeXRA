// Local imports - progress view
import { COMMANDS, STATUS, ELEMENT_IDS } from './constants.js';
import { progressViewDomHandler, LogEntryFormatter } from './domHandlers.js';
import { createThemeHandlers } from './handlers/themeHandlers.js';
import { appendFormatted } from './utils.js';
// Local imports - log state
import { progressViewState } from './progressViewState.js';
import { BaseWebviewMessageHandler } from '@common/BaseWebviewMessageHandler.js';

// Session kind values match TypeScript AgentSessionKind enum
// No need to duplicate - we use the actual values from messages

// Create shorter aliases for internal use
const state = progressViewState;
const dom = progressViewDomHandler;

const updateInstructionPanelForSelection = (selectionId) => {
  const activeStream = state.activeStream;
  if (!activeStream) {
    dom.instructionPanel.hide();
    return;
  }

  const targetId = selectionId ?? state.getSelectedRootGroup(activeStream);
  if (!targetId) {
    dom.instructionPanel.hide();
    return;
  }

  const group = state.taskGroups.get(targetId);
  const instruction = group?.instruction;

  if (instruction?.text) {
    dom.instructionPanel.show(instruction.text, instruction.metadata);
  } else {
    dom.instructionPanel.hide();
  }
};

const updateSessionSelector = (groups, preferredId) => {
  const selected = dom.sessionSelector.updateOptions(groups, preferredId);
  const activeStream = state.activeStream;

  if (activeStream) {
    if (selected) {
      state.setSelectedRootGroup(activeStream, selected);
    } else {
      state.clearSelectedRootGroup(activeStream);
    }
  }

  dom.taskGroups.setVisibleRootGroup(selected);
  updateInstructionPanelForSelection(selected);
  return selected;
};

dom.sessionSelector.setOnChange((groupId) => {
  const activeStream = state.activeStream;
  if (!activeStream) {
    return;
  }

  if (groupId) {
    state.setSelectedRootGroup(activeStream, groupId);
  } else {
    state.clearSelectedRootGroup(activeStream);
  }

  dom.taskGroups.setVisibleRootGroup(groupId);
  updateInstructionPanelForSelection(groupId);
});

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
      [COMMANDS.UPDATE_INSTRUCTION]: (m) => this.handleUpdateInstruction(m),
      [COMMANDS.DELETE_STREAM]: (m) => this.handleDeleteStream(m),
      [COMMANDS.DELETE_ALL]: () => this.handleDeleteAll(),
    };
  }

  handleUpdateStreams(message) {
    state.activeStream = message.activeStream;
    state.agentFilter = message.agentFilter || 'all';
    state.resetExecutionAvailability();
    message.streams.forEach((s) => {
      if (s.status) {
        state.streamStatuses.set(s.name, s.status);
      } else {
        state.streamStatuses.delete(s.name);
      }
      state.setExecutionAvailability(s.name, Boolean(s.executionId));
    });
    dom.streamTabs.update(message.streams, message.activeStream);

    const filterContainer = document.getElementById(
      ELEMENT_IDS.AGENT_FILTER_CONTAINER,
    );
    if (filterContainer) {
      filterContainer.querySelectorAll('button[data-filter]').forEach((btn) => {
        const isActive = btn.dataset.filter === state.agentFilter;
        btn.classList.toggle('toggled', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    }

    this._updatePlaceholderVisibility();

    const activeStreamInfo = message.streams.find(
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

    const hasExecution = state.getExecutionAvailability(message.activeStream);
    dom.status.setExecutionAvailability(Boolean(hasExecution));

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
      const previousSelection = state.getSelectedRootGroup(message.stream);
      logContent.innerHTML = '';
      state.taskGroups.clear();
      dom.taskGroups.clear();
      const groups = Array.isArray(message.groups) ? message.groups : [];
      if (groups.length > 0) {
        const parentGroups = groups.filter((g) => !g.parentGroupId);
        const childGroups = groups.filter((g) => g.parentGroupId);
        parentGroups
          .sort((a, b) => a.startTime - b.startTime)
          .forEach((g) => dom.taskGroups.add(g));
        childGroups
          .sort((a, b) => a.startTime - b.startTime)
          .forEach((g) => dom.taskGroups.add(g));
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
      logContent.scrollTop = logContent.scrollHeight;

      // Recalculate cumulative usage after loading groups
      dom.usageSummary.update();

      const preferredGroupId = message.taskGroupId || previousSelection || null;
      updateSessionSelector(groups, preferredGroupId);
    }

    this._updatePlaceholderVisibility();
  }

  handleClearLogs() {
    const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    logContent.innerHTML = '';
    const groupIds = [];
    const headers = Array.from(document.querySelectorAll('.log-group-header'));
    for (const el of headers) {
      groupIds.push(el.id.replace('group-header-', ''));
    }
    state.taskGroups.clear();
    dom.taskGroups.clear();
    state.clearSelectedRootGroup(state.activeStream);
    dom.sessionSelector.clear();
    updateInstructionPanelForSelection(null);
    state.toggleStates.clear(groupIds);

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
      logContent.scrollTop = logContent.scrollHeight;
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
        logContent.scrollTop = logContent.scrollHeight;
      }
    }
  }

  handleAddTaskGroup(message) {
    if (message.stream === state.activeStream) {
      const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
      dom.taskGroups.add(message.group);
      logContent.scrollTop = logContent.scrollHeight;
    }
  }

  handleUpdateTaskGroup(message) {
    if (message.stream === state.activeStream) {
      state.taskGroups.update(message.groupId, message.status, message.endTime);
      dom.taskGroups.update(message.groupId, message.status, message.endTime);
    }
  }

  handleUpdateStatus(message) {
    const hasExecution = state.getExecutionAvailability(state.activeStream);
    dom.status.setExecutionAvailability(Boolean(hasExecution));
    dom.status.update(message.status);
  }

  handleUpdateUsage(message) {
    dom.usageSummary.update(message.usage);
  }

  handleUpdateGroupUsage(message) {
    if (message.stream === state.activeStream) {
      dom.usageGroup.update(message.groupId, message.usage);
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

  /**
   * @param {{
   *   stream: string | null,
   *   instruction: import('../types').InstructionUpdate | null
   * }} message
   */
  handleUpdateInstruction(message) {
    const { stream, instruction, taskGroupId } = message;
    const activeStream = state.activeStream || '';

    if (!stream || stream !== activeStream) {
      return;
    }

    const groups = Array.isArray(message.groups) ? message.groups : [];
    if (groups.length > 0) {
      groups.forEach((group) => {
        if (group?.id) {
          state.taskGroups.set(group.id, group);
        }
      });
    }

    if (typeof taskGroupId === 'string') {
      const existingGroup = state.taskGroups.get(taskGroupId);
      if (existingGroup) {
        state.taskGroups.set(taskGroupId, {
          ...existingGroup,
          instruction: instruction ? { ...instruction } : undefined,
        });
      }
    }

    const preferredGroupId =
      taskGroupId || state.getSelectedRootGroup(stream) || null;

    if (groups.length > 0) {
      updateSessionSelector(groups, preferredGroupId);
    } else if (taskGroupId && !state.getSelectedRootGroup(stream)) {
      state.setSelectedRootGroup(stream, taskGroupId);
      dom.taskGroups.setVisibleRootGroup(taskGroupId);
    }

    const selection = state.getSelectedRootGroup(stream) || taskGroupId || null;
    updateInstructionPanelForSelection(selection);
  }

  handleDeleteStream(message) {
    if (message.stream) {
      state.streamStatuses.delete(message.stream);
      state.clearExecutionAvailability(message.stream);
      if (message.stream === state.activeStream) {
        const groupIds = [];
        const headers = Array.from(
          document.querySelectorAll('.log-group-header'),
        );
        for (const el of headers) {
          groupIds.push(el.id.replace('group-header-', ''));
        }
        state.toggleStates.clear(groupIds);
        state.clearSelectedRootGroup(message.stream);
        dom.sessionSelector.clear();
        dom.instructionPanel.hide();
      }
    }
  }

  handleDeleteAll() {
    state.toggleStates.clearAll();
    state.resetExecutionAvailability();
    state.clearSelectedRootGroup(state.activeStream);
    dom.sessionSelector.clear();
    dom.instructionPanel.hide();
  }
}

export const messageHandler = new ProgressViewMessageHandler();
