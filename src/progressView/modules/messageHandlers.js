/* global vscode */

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

// Create formatter instances

export class ProgressViewMessageHandler extends BaseWebviewMessageHandler {
  constructor() {
    super();
    this._entryFormatter = new LogEntryFormatter();
    this._handlers = {
      ...createThemeHandlers(),
      ...this._createHandlers(),
    };
    dom.sessionSelector.setOnChange((groupId) =>
      this._handleSessionSelection(groupId),
    );
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

  _getCurrentGroups(stream = state.activeStream) {
    if (!stream) {
      return [];
    }
    return Array.from(state.taskGroups.getAll(stream).values());
  }

  _syncSessionSelector(groups, preferredGroupId, stream = state.activeStream) {
    const selectedId = dom.sessionSelector.update(groups, preferredGroupId);
    if (stream) {
      state.setSelectedGroup(stream, selectedId || null);
      dom.taskGroups.setRootGroupVisibility(stream, selectedId);
    }
    return selectedId;
  }

  _applyInstructionForSelection(
    groupId,
    instructionPayload,
    stream = state.activeStream,
  ) {
    if (!groupId) {
      dom.instructionPanel.hide();
      return;
    }

    const group = stream ? state.taskGroups.get(stream, groupId) : null;
    const text = instructionPayload?.text || group?.instruction?.text || '';

    if (!text.trim()) {
      dom.instructionPanel.hide();
      return;
    }

    const metadata =
      instructionPayload?.metadata || group?.instruction?.metadata || {};
    dom.instructionPanel.show(text, metadata);
  }

  _handleSessionSelection(groupId) {
    const activeStream = state.activeStream;
    if (!activeStream) {
      dom.instructionPanel.hide();
      return;
    }

    const selectedId = groupId || dom.sessionSelector.getValue();
    state.setSelectedGroup(activeStream, selectedId || null);
    dom.taskGroups.setRootGroupVisibility(activeStream, selectedId);
    this._applyInstructionForSelection(selectedId, undefined, activeStream);

    // Notify extension to update files/usage for the selected session
    if (selectedId) {
      vscode.postMessage({
        command: COMMANDS.SELECT_SESSION,
        stream: activeStream,
        sessionId: selectedId,
      });
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
    message.streams.forEach((s) => {
      if (s.status) {
        state.streamStatuses.set(s.name, s.status);
      } else {
        state.streamStatuses.delete(s.name);
      }
      // executionId is now tracked in ProgressViewState._executionIds (TypeScript)
      // No need to duplicate it here
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

    // Derive execution availability from whether there are any sessions (task groups)
    // Check if the active stream has any root task groups
    const latestGroupId = activeStreamInfo
      ? state.taskGroups.getLatestRootGroupId(message.activeStream)
      : null;
    const executionId =
      activeStreamInfo?.executionId ??
      activeStreamInfo?.session?.executionId ??
      null;
    const hasExecution = Boolean(executionId || latestGroupId);
    dom.status.setExecutionAvailability(hasExecution);

    const activeSelection = state.getSelectedGroup(message.activeStream);
    state.setCurrentGroup(message.activeStream, activeSelection || null);

    // Update status based on whether there's an active stream
    if (!message.activeStream) {
      dom.status.update(STATUS.READY);
      dom.instructionPanel.hide();
      dom.sessionSelector.update([], null);
    } else {
      const streamStatus = state.streamStatuses.get(message.activeStream);
      dom.status.update(streamStatus || STATUS.STOPPED);
    }
  }

  handleUpdateLogs(message) {
    const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    if (message.stream === state.activeStream) {
      logContent.innerHTML = '';
      state.taskGroups.clear(message.stream);
      state.setCurrentGroup(message.stream, null);
      dom.taskGroups.clear();
      if (message.groups && message.groups.length > 0) {
        const parentGroups = message.groups.filter((g) => !g.parentGroupId);
        const childGroups = message.groups.filter((g) => g.parentGroupId);
        parentGroups
          .sort((a, b) => a.startTime - b.startTime)
          .forEach((g) => dom.taskGroups.add(g));
        childGroups
          .sort((a, b) => a.startTime - b.startTime)
          .forEach((g) => dom.taskGroups.add(g));
      }
      const groups = this._getCurrentGroups(message.stream);
      const preferredGroupId =
        message.taskGroupId || state.getSelectedGroup(message.stream);
      const selectedGroupId = this._syncSessionSelector(
        groups,
        preferredGroupId,
        message.stream,
      );
      this._applyInstructionForSelection(
        selectedGroupId,
        undefined,
        message.stream,
      );
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
    const activeStream = state.activeStream;
    state.taskGroups.clear(activeStream);
    state.setCurrentGroup(activeStream, null);
    dom.taskGroups.clear();
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

      // If this is a new root group (session), switch to it automatically
      const isRootGroup = !message.group.parentGroupId;
      if (isRootGroup) {
        const groups = this._getCurrentGroups(message.stream);
        const selectedGroupId = this._syncSessionSelector(
          groups,
          message.group.id,
          message.stream,
        );
        this._applyInstructionForSelection(
          selectedGroupId,
          undefined,
          message.stream,
        );
      }

      logContent.scrollTop = logContent.scrollHeight;
    }
  }

  handleUpdateTaskGroup(message) {
    if (message.stream === state.activeStream) {
      state.taskGroups.update(
        message.stream,
        message.groupId,
        message.status,
        message.endTime,
      );
      dom.taskGroups.update(message.groupId, message.status, message.endTime);
    }
  }

  handleUpdateStatus(message) {
    // Derive execution availability from whether we have a session
    const latestGroupId = state.taskGroups.getLatestRootGroupId(
      state.activeStream,
    );
    const hasExecution = Boolean(latestGroupId);
    dom.status.setExecutionAvailability(hasExecution);
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
    console.log('[UPDATE_FILES] Received:', {
      stream: message.stream,
      activeStream: state.activeStream,
      fileRounds: Object.keys(message.files || {}).length,
    });
    if (message.stream === state.activeStream) {
      console.log('[UPDATE_FILES] Updating file list with', message.files);
      dom.fileList.update(message.files);
    } else {
      console.log('[UPDATE_FILES] Skipping update - stream mismatch');
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
    const activeStream = state.activeStream || '';

    if (message.stream !== activeStream) {
      if (!activeStream && !message.stream) {
        dom.instructionPanel.hide();
      }
      return;
    }

    if (Array.isArray(message.groups)) {
      message.groups.forEach((group) => {
        if (group?.id) {
          state.taskGroups.set(message.stream, group.id, group);
        }
      });
    }

    let instructionGroupId = message.taskGroupId || null;

    if (instructionGroupId) {
      const existing =
        state.taskGroups.get(message.stream, instructionGroupId) ||
        { id: instructionGroupId };
      const updated = { ...existing };
      if (message.instruction) {
        updated.instruction = {
          text: message.instruction.text,
          metadata: message.instruction.metadata,
        };
      } else {
        updated.instruction = undefined;
      }
      state.taskGroups.set(message.stream, instructionGroupId, updated);
    } else if (message.instruction) {
      const fallbackGroupId = state.taskGroups.getLatestRootGroupId(
        message.stream,
      );
      if (fallbackGroupId) {
        instructionGroupId = fallbackGroupId;
        const existing =
          state.taskGroups.get(message.stream, fallbackGroupId) ||
          { id: fallbackGroupId };
        const updated = { ...existing };
        updated.instruction = {
          text: message.instruction.text,
          metadata: message.instruction.metadata,
        };
        state.taskGroups.set(message.stream, fallbackGroupId, updated);
      }
    }

    const groups = this._getCurrentGroups(message.stream);
    const preferredGroupId =
      instructionGroupId || state.getSelectedGroup(activeStream);
    const selectedGroupId = this._syncSessionSelector(
      groups,
      preferredGroupId,
      message.stream,
    );

    const shouldApplyInstruction =
      !!message.instruction && selectedGroupId === instructionGroupId;
    this._applyInstructionForSelection(
      selectedGroupId,
      shouldApplyInstruction ? message.instruction : undefined,
      message.stream,
    );
  }

  handleDeleteStream(message) {
    if (message.stream) {
      state.streamStatuses.delete(message.stream);
      state.setSelectedGroup(message.stream, null);
      if (message.stream === state.activeStream) {
        const groupIds = [];
        const headers = Array.from(
          document.querySelectorAll('.log-group-header'),
        );
        for (const el of headers) {
          groupIds.push(el.id.replace('group-header-', ''));
        }
        state.toggleStates.clear(groupIds);
        dom.instructionPanel.hide();
        state.taskGroups.clear(message.stream);
        state.setCurrentGroup(message.stream, null);
      }
    }
  }

  handleDeleteAll() {
    state.toggleStates.clearAll();
    state.selectedGroups.clear();
    state.currentGroupIds.clear();
    dom.instructionPanel.hide();
    dom.sessionSelector.update([], null);
  }
}

export const messageHandler = new ProgressViewMessageHandler();
