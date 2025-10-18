// Local imports - progress view
import { ELEMENT_IDS } from './constants.js';
import { TaskGroupHeaderFormatter, LogEntryFormatter } from './formatters.js';
// Local imports
import { progressViewState } from './progressViewState.js';
import { insertChronologically } from './utils.js';
import { createFromTemplate } from '@common/templateUtils.js';

const ACTIVE_RUN_CLASS = 'log-group--active-run';

/**
 * Manages task group DOM operations.
 */
export class TaskGroupManager {
  constructor() {
    this.headerFormatter = new TaskGroupHeaderFormatter();
    this.previousActiveGroupId = null;
    this.groupNodes = new Map();
    this.activeRunId = null;
  }

  /**
   * Adds a log group to the DOM
   * @param {Object} group - Group data
   */
  add(group) {
    const existingNode = this.groupNodes.get(group.id);
    if (existingNode) {
      if (!progressViewState.taskGroups.get(group.id)) {
        console.warn(
          `Group ${group.id} exists in DOM but not in state - removing from DOM`,
        );
        existingNode.wrapper?.remove();
        this.groupNodes.delete(group.id);
      } else {
        progressViewState.taskGroups.set(group.id, group);
        this.update(group.id, group.status, group.endTime);
        return;
      }
    }

    const isRoot = !group.parentGroupId;
    const shouldFlattenRoot =
      isRoot && progressViewState.isWorkflowSelectorActive();

    const node = shouldFlattenRoot
      ? this._createFlattenedGroupNode(group)
      : this._createStandardGroupNode(group);

    if (!node) {
      return;
    }

    progressViewState.taskGroups.set(group.id, group);
    this.groupNodes.set(group.id, {
      ...node,
      isRoot,
      isFlattened: shouldFlattenRoot,
    });

    const container = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    if (!container) {
      console.error('TaskGroupManager.add: log container not found');
      return;
    }

    if (group.parentGroupId) {
      const parentNode = this.groupNodes.get(group.parentGroupId);
      const parentContent = parentNode?.content;
      if (parentContent) {
        insertChronologically(parentContent, node.wrapper, group.startTime);
        return;
      }
    }

    insertChronologically(container, node.wrapper, group.startTime);

    if (isRoot) {
      progressViewState.currentGroupId = group.id;
      if (!shouldFlattenRoot) {
        this.collapsePreviousActiveGroup();
      }
      this._applyActiveRunClass(group.id);
    }
  }

  _createStandardGroupNode(group) {
    const detailsElem = createFromTemplate('groupDetailsTemplate');
    if (!detailsElem) {
      console.error('TaskGroupManager.add: groupDetailsTemplate not found');
      return null;
    }
    detailsElem.id = `group-${group.id}`;
    detailsElem.dataset.start = `${group.startTime ?? Date.now()}`;

    const headerElement = this.headerFormatter.create(group);
    if (!headerElement) {
      console.error('TaskGroupManager.add: failed to create group header');
      return null;
    }

    const groupContainer = detailsElem.querySelector('.log-group-content');
    if (!groupContainer) {
      console.error('TaskGroupManager.add: missing group content container');
      return null;
    }
    groupContainer.id = `group-content-${group.id}`;

    const isCollapsed = progressViewState.toggleStates.get(group.id);
    detailsElem.open = isCollapsed !== true;

    detailsElem.prepend(headerElement);

    detailsElem.addEventListener('toggle', () => {
      progressViewState.toggleStates.set(group.id, !detailsElem.open);
    });

    return { wrapper: detailsElem, content: groupContainer };
  }

  _createFlattenedGroupNode(group) {
    const wrapper = document.createElement('div');
    wrapper.className = 'log-group log-group--flattened';
    wrapper.id = `group-${group.id}`;
    wrapper.dataset.start = `${group.startTime ?? Date.now()}`;

    const content = document.createElement('div');
    content.className = 'log-group-content';
    content.id = `group-content-${group.id}`;
    wrapper.appendChild(content);

    return { wrapper, content };
  }

  /**
   * Updates the UI of a log group's header
   * @param {string} groupId - ID of the group to update
   * @param {string} status - New status
   * @param {string} endTime - End time (optional)
   */
  update(groupId, status, endTime) {
    const group = progressViewState.taskGroups.get(groupId);
    if (!group) return;

    group.status = status;
    if (endTime) {
      group.endTime = endTime;
    }

    const node = this.groupNodes.get(groupId);
    const wrapper = node?.wrapper;
    if (!(wrapper instanceof HTMLDetailsElement)) {
      return;
    }

    const header = wrapper.querySelector('.log-group-header');
    if (header) {
      const level = this.headerFormatter._getGroupLevel(group);
      header.className = this.headerFormatter._getHeaderClass(group, level);

      const statusIconElem = header.querySelector('.group-status-icon');
      if (statusIconElem) {
        statusIconElem.innerHTML = this.headerFormatter._getStatusIcon(status);
      }

      const timeContainer = header.querySelector('.group-time');

      if (endTime) {
        const endDate = endTime;
        const startDate = group.startTime;
        const durationMs = endDate - startDate;

        const durationElem = header.querySelector('.group-duration');
        if (durationElem) {
          durationElem.textContent = `${this.headerFormatter._formatDuration(durationMs)}`;
          durationElem.style.display = 'inline';
        } else if (timeContainer) {
          const durationSpan = document.createElement('span');
          durationSpan.className = 'group-duration';
          durationSpan.textContent = `${this.headerFormatter._formatDuration(durationMs)}`;
          durationSpan.style.display = 'inline';
          timeContainer.appendChild(durationSpan);
        }

        if (/^r\d+$/.test(group.name)) {
          this.playSystemSound();
        }
      }
    }
  }

  setActiveRunId(runId) {
    this.activeRunId = runId || null;
    for (const [groupId, node] of this.groupNodes.entries()) {
      if (!node.isRoot) {
        continue;
      }
      this._toggleActiveRunClass(node, groupId === this.activeRunId);
    }
  }

  _applyActiveRunClass(groupId) {
    const node = this.groupNodes.get(groupId);
    if (!node || !node.isRoot) {
      return;
    }
    this._toggleActiveRunClass(node, groupId === this.activeRunId);
  }

  _toggleActiveRunClass(node, isActive) {
    const { wrapper, isFlattened } = node;
    if (!wrapper) {
      return;
    }
    if (isActive) {
      wrapper.classList.add(ACTIVE_RUN_CLASS);
      if (!isFlattened && wrapper instanceof HTMLDetailsElement) {
        wrapper.open = true;
        progressViewState.toggleStates.set(
          wrapper.id.replace('group-', ''),
          false,
        );
      }
    } else {
      wrapper.classList.remove(ACTIVE_RUN_CLASS);
    }
  }

  /**
   * Collapse a group and all of its child groups recursively
   * @private
   * @param {string} groupId - ID of the group to collapse
   */
  collapseGroupAndChildren(groupId) {
    for (const [childId, group] of progressViewState.taskGroups.getAll()) {
      if (group.parentGroupId === groupId) {
        this.collapseGroupAndChildren(childId);
      }
    }

    const node = this.groupNodes.get(groupId);
    const wrapper = node?.wrapper;
    if (wrapper instanceof HTMLDetailsElement) {
      wrapper.open = false;
      progressViewState.toggleStates.set(groupId, true);
    }
  }

  /**
   * Find the currently active group (most recent non-collapsed group).
   * @private
   * @returns {string|null} - ID of the current active group or null
   */
  findCurrentActiveGroup() {
    const current = progressViewState.taskGroups.get(
      progressViewState.currentGroupId,
    );
    if (current) return current.id;

    let latestGroup = null;
    let latestTime = 0;

    for (const [id, node] of this.groupNodes.entries()) {
      const wrapper = node.wrapper;
      if (!(wrapper instanceof HTMLDetailsElement) || !wrapper.open) {
        continue;
      }

      const group = progressViewState.taskGroups.get(id);
      if (!group) {
        continue;
      }

      if (group.startTime > latestTime) {
        latestGroup = id;
        latestTime = group.startTime;
      }
    }

    return latestGroup;
  }

  /**
   * Collapse the previous active group when focus changes.
   * Used to keep only the current task group expanded.
   */
  collapsePreviousActiveGroup() {
    const currentId = this.findCurrentActiveGroup();

    if (
      this.previousActiveGroupId &&
      this.previousActiveGroupId !== currentId
    ) {
      this.collapseGroupAndChildren(this.previousActiveGroupId);
    }

    this.previousActiveGroupId = currentId;
  }

  /**
   * Play a short beep using the Web Audio API.
   * @private
   */
  playSystemSound() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 880;
      osc.connect(ctx.destination);
      osc.start();
      setTimeout(() => {
        osc.stop();
        ctx.close();
      }, 150);
    } catch (err) {
      // Ignore errors (e.g. autoplay restrictions)
    }
  }

  /**
   * Clear cached group references.
   */
  clear() {
    this.groupNodes.clear();
    this.previousActiveGroupId = null;
    this.activeRunId = null;
  }
}

/**
 * Manages individual log entry DOM operations.
 */
export class LogEntryManager {
  constructor() {
    this.entryFormatter = new LogEntryFormatter();
  }

  /**
   * Appends a log message to its group or to the main content
   * @param {Object} logMessage - The log message to append
   * @returns {boolean} Whether the message was appended to a group
   */
  append(logMessage) {
    // If the message has a group ID, append it to the right group
    if (logMessage.groupId) {
      const groupContent = document.getElementById(
        `group-content-${logMessage.groupId}`,
      );
      if (groupContent) {
        const logLineElement = this.entryFormatter.format(logMessage);
        if (!logLineElement) {
          return true;
        }

        // Extract timestamp from the message for chronological ordering
        const msgDate = new Date(logMessage.timestamp);

        insertChronologically(groupContent, logLineElement, msgDate);

        return true;
      }
    }

    return false;
  }

  /**
   * Update an existing log entry identified by ID
   * @param {Object} logMessage - The log message with updated content
   * @returns {boolean} Whether the log entry was updated
   */
  update(logMessage) {
    const existing = document.querySelector(`[data-log-id="${logMessage.id}"]`);
    if (existing) {
      // Preserve the expanded/collapsed state for thinking and scratchpad
      const wasOpen = existing.hasAttribute('open');
      const newEl = this.entryFormatter.format(logMessage);
      if (!newEl) {
        existing.remove();
        return true;
      }

      // Restore the expanded state if it was open
      if (
        wasOpen &&
        (logMessage.messageType === 'thinking' ||
          logMessage.messageType === 'scratchpad')
      ) {
        newEl.setAttribute('open', '');
        const toggleIcon = newEl.querySelector('.toggle-icon');
        if (toggleIcon) {
          toggleIcon.className = 'codicon codicon-chevron-down toggle-icon';
        }
      }

      existing.replaceWith(newEl);
      return true;
    }
    return false;
  }
}
