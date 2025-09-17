// Local imports - progress view
import { COMMANDS, STATUS, ELEMENT_IDS } from './constants.js';
import { progressViewDomHandler, LogEntryFormatter } from './domHandlers.js';
import { createThemeHandlers } from './handlers/themeHandlers.js';
import { appendFormatted } from './utils.js';
// Local imports - log state
import { progressViewState } from './progressViewState.js';
import { BaseWebviewMessageHandler } from '@common/BaseWebviewMessageHandler.js';

// Create shorter aliases for internal use
const state = progressViewState;
const dom = progressViewDomHandler;

// Create formatter instances

const TOOLBAR_ACTION_BUTTON_IDS = [
  ELEMENT_IDS.RUN_AGAIN_BTN,
  ELEMENT_IDS.DIFF_STREAM_BTN,
  ELEMENT_IDS.PACK_STREAM_BTN,
  ELEMENT_IDS.CLEAN_STREAM_BTN,
];

const DEFAULT_STREAM_CAPABILITIES = Object.freeze({
  canRunAgain: true,
  canDiffStream: true,
  canPackStream: true,
  canCleanStream: true,
  canSendFollowUp: false,
});

let toolbarActionButtonCache = null;

function getToolbarActionButtons() {
  if (
    Array.isArray(toolbarActionButtonCache) &&
    toolbarActionButtonCache.every((button) => button?.isConnected)
  ) {
    return toolbarActionButtonCache;
  }

  toolbarActionButtonCache = TOOLBAR_ACTION_BUTTON_IDS.map((id) =>
    document.getElementById(id),
  ).filter((el) => el instanceof HTMLButtonElement);
  return toolbarActionButtonCache;
}

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
    const capabilities = {
      ...DEFAULT_STREAM_CAPABILITIES,
      ...(activeStreamInfo?.capabilities || {}),
    };
    const isToolUseAgent = Boolean(activeStreamInfo?.isToolUseAgent);

    const container = document.getElementById(ELEMENT_IDS.FOLLOW_UP_CONTAINER);
    if (container) {
      const followUpVisible = Boolean(capabilities.canSendFollowUp);
      container.classList.toggle('is-visible', followUpVisible);
      container.setAttribute('aria-hidden', followUpVisible ? 'false' : 'true');
    }

    const buttonVisibility = new Map([
      [ELEMENT_IDS.RUN_AGAIN_BTN, capabilities.canRunAgain],
      [ELEMENT_IDS.DIFF_STREAM_BTN, capabilities.canDiffStream],
      [ELEMENT_IDS.PACK_STREAM_BTN, capabilities.canPackStream],
      [ELEMENT_IDS.CLEAN_STREAM_BTN, capabilities.canCleanStream],
    ]);

    const toolbar = document.getElementById(ELEMENT_IDS.TOOLBAR_CONTAINER);
    if (toolbar) {
      toolbar.dataset.agentType = activeStreamInfo?.agentType || '';
      toolbar.dataset.agentMode = isToolUseAgent ? 'tool' : 'workflow';
    }

    const toolbarButtons = getToolbarActionButtons();
    toolbarButtons.forEach((button) => {
      const supportsAction = buttonVisibility.has(button.id)
        ? buttonVisibility.get(button.id)
        : true;
      const shouldHide = buttonVisibility.has(button.id) && !supportsAction;
      button.classList.toggle('toolbar-button--hidden', shouldHide);
      if (shouldHide) {
        button.setAttribute('aria-hidden', 'true');
        button.setAttribute('tabindex', '-1');
        button.dataset.hiddenByAgent = 'true';
        button.disabled = true;
      } else {
        button.removeAttribute('aria-hidden');
        button.removeAttribute('tabindex');
        delete button.dataset.hiddenByAgent;
      }
    });

    // Update status based on whether there's an active stream
    if (!message.activeStream) {
      dom.status.update(STATUS.READY);
    } else {
      const streamStatus = state.streamStatuses.get(message.activeStream);
      dom.status.update(streamStatus || STATUS.STOPPED);
    }
  }

  handleUpdateLogs(message) {
    const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    if (message.stream === state.activeStream) {
      logContent.innerHTML = '';
      state.taskGroups.clear();
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
    state.taskGroups.clear();
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

  handleDeleteStream(message) {
    if (message.stream) {
      state.streamStatuses.delete(message.stream);
      if (message.stream === state.activeStream) {
        const groupIds = [];
        const headers = Array.from(
          document.querySelectorAll('.log-group-header'),
        );
        for (const el of headers) {
          groupIds.push(el.id.replace('group-header-', ''));
        }
        state.toggleStates.clear(groupIds);
      }
    }
  }

  handleDeleteAll() {
    state.toggleStates.clearAll();
  }
}

export const messageHandler = new ProgressViewMessageHandler();
