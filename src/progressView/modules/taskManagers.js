// Local imports - progress view
import { ELEMENT_IDS } from './constants.js';
import { TaskGroupHeaderFormatter, LogEntryFormatter } from './formatters.js';
// Local imports
import { progressViewState } from './progressViewState.js';
import { insertChronologically } from './utils.js';
import { createFromTemplate } from '@common/templateUtils.js';

/**
 * Manages task group DOM operations.
 */
export class TaskGroupDomManager {
  constructor() {
    this.headerFormatter = new TaskGroupHeaderFormatter();
    this.previousActiveGroupId = null;
    this.groupElements = new Map();
    this.groupObservers = new Map();
  }

  /**
   * Adds a log group to the DOM
   * @param {Object} group - Group data
   */
  addGroup(group) {
    const existingGroup = this.groupElements.get(group.id);
    if (existingGroup) {
      if (!progressViewState.taskGroups.get(group.id)) {
        console.warn(
          `Group ${group.id} exists in DOM but not in state - removing from DOM`,
        );
        this._disconnectObserver(group.id);
        existingGroup.remove();
        this.groupElements.delete(group.id);
      } else {
        progressViewState.taskGroups.set(group.id, group);
        this.updateGroup({
          groupId: group.id,
          updates: {
            status: group.status,
            endTime: group.endTime,
          },
        });
        return;
      }
    }

    const treeItem = createFromTemplate('groupDetailsTemplate');
    if (!treeItem) {
      console.error(
        'TaskGroupDomManager.addGroup: groupDetailsTemplate not found',
      );
      return;
    }
    treeItem.id = `group-${group.id}`;
    treeItem.dataset.groupId = group.id;
    treeItem.setAttribute('branch', '');

    const headerElement = this.headerFormatter.create(group);
    if (!headerElement) {
      console.error(
        'TaskGroupDomManager.addGroup: failed to create group header',
      );
      return;
    }

    treeItem.appendChild(headerElement);

    progressViewState.taskGroups.set(group.id, group);

    const isCollapsed = progressViewState.toggleStates.get(group.id) === true;
    treeItem.open = !isCollapsed;
    if (treeItem.open) {
      treeItem.setAttribute('open', '');
    } else {
      treeItem.removeAttribute('open');
    }

    this._observeGroup(treeItem, group.id);

    this.groupElements.set(group.id, treeItem);

    const treeRoot = this._getTreeRoot();
    if (!treeRoot) {
      console.error('TaskGroupDomManager.addGroup: log group tree missing');
      return;
    }

    if (group.parentGroupId) {
      const parentItem = this.groupElements.get(group.parentGroupId);
      if (parentItem instanceof HTMLElement) {
        treeItem.slot = 'children';
        insertChronologically({
          container: parentItem,
          element: treeItem,
          timestamp: group.startTime,
        });
        return;
      }
    } else {
      treeItem.removeAttribute('slot');
    }

    // For top-level groups, insert in chronological order
    insertChronologically({
      container: treeRoot,
      element: treeItem,
      timestamp: group.startTime,
    });

    // For top-level groups, update current group and collapse the previous active group
    if (!group.parentGroupId) {
      progressViewState.currentGroupId = group.id;
      this.collapsePreviousActiveGroup();
    }
  }

  _getTreeRoot() {
    let tree = document.getElementById(ELEMENT_IDS.LOG_GROUP_TREE);
    if (tree) {
      return tree;
    }

    const container = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    if (!container) {
      return null;
    }

    tree = document.createElement('vscode-tree');
    tree.id = ELEMENT_IDS.LOG_GROUP_TREE;
    tree.classList.add('log-group-tree');
    container.prepend(tree);
    return tree;
  }

  _observeGroup(treeItem, groupId) {
    if (!(treeItem instanceof HTMLElement)) {
      return;
    }

    this._disconnectObserver(groupId);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (
          mutation.type === 'attributes' &&
          mutation.attributeName === 'open'
        ) {
          const isCollapsed = !treeItem.hasAttribute('open');
          progressViewState.toggleStates.set(groupId, isCollapsed);
        }
      }
    });

    observer.observe(treeItem, {
      attributes: true,
      attributeFilter: ['open'],
    });

    this.groupObservers.set(groupId, observer);
  }

  _disconnectObserver(groupId) {
    const existing = this.groupObservers.get(groupId);
    if (existing) {
      existing.disconnect();
      this.groupObservers.delete(groupId);
    }
  }

  /**
   * Updates the UI of a log group's header
   * @param {string} groupId - ID of the group to update
   * @param {string} status - New status
   * @param {string} endTime - End time (optional)
   */
  updateGroup(update) {
    if (!update || typeof update !== 'object') {
      return;
    }

    const { groupId, updates = {} } = update;
    if (!groupId) {
      return;
    }

    const group = progressViewState.taskGroups.get(groupId);
    if (!group) return;

    const hasStatusUpdate = Object.prototype.hasOwnProperty.call(
      updates,
      'status',
    );
    const hasEndTimeUpdate = Object.prototype.hasOwnProperty.call(
      updates,
      'endTime',
    );

    if (hasStatusUpdate && updates.status) {
      group.status = updates.status;
    }
    if (
      hasEndTimeUpdate &&
      updates.endTime !== undefined &&
      updates.endTime !== null
    ) {
      group.endTime = updates.endTime;
    }

    const treeItem = this.groupElements.get(groupId);
    if (!(treeItem instanceof HTMLElement)) {
      return;
    }

    const header = treeItem.querySelector('.log-group-header');
    if (header) {
      const level = this.headerFormatter._getGroupLevel(group);
      header.className = this.headerFormatter._getHeaderClass(group, level);

      // Update the status icon
      const statusIconElem = header.querySelector('.group-status-icon');
      if (statusIconElem) {
        statusIconElem.innerHTML = this.headerFormatter._getStatusIcon(
          group.status,
        );
      }

      // Update or add the duration display when the group finishes
      const timeContainer = header.querySelector('.group-time');

      if (
        hasEndTimeUpdate &&
        group.endTime !== undefined &&
        group.endTime !== null
      ) {
        const endDate = group.endTime;
        const startDate = group.startTime;
        const durationMs = endDate - startDate;

        // Update or create duration element
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

    progressViewState.taskGroups.set(groupId, group);
  }

  /**
   * Collapse a group and all of its child groups recursively
   * @private
   * @param {string} groupId - ID of the group to collapse
   */
  collapseGroupAndChildren(groupId) {
    const taskGroups = progressViewState.taskGroups.getGroupMap();

    for (const [childId, group] of taskGroups.entries()) {
      if (group.parentGroupId === groupId) {
        this.collapseGroupAndChildren(childId);
      }
    }

    // Collapse this group
    const treeItem = this.groupElements.get(groupId);
    if (treeItem instanceof HTMLElement) {
      treeItem.open = false;
      treeItem.removeAttribute('open');
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

    for (const [id, treeItem] of this.groupElements.entries()) {
      if (!(treeItem instanceof HTMLElement) || !treeItem.open) {
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

    // Collapse the previous group if it's different from current
    if (
      this.previousActiveGroupId &&
      this.previousActiveGroupId !== currentId
    ) {
      this.collapseGroupAndChildren(this.previousActiveGroupId);
    }

    // Update the previous ID to current for next time
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
    this.groupElements.clear();
    for (const observer of this.groupObservers.values()) {
      observer.disconnect();
    }
    this.groupObservers.clear();
    this.previousActiveGroupId = null;

    const treeRoot = document.getElementById(ELEMENT_IDS.LOG_GROUP_TREE);
    if (treeRoot) {
      treeRoot.innerHTML = '';
    }
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
      const groupElement = document.getElementById(
        `group-${logMessage.groupId}`,
      );
      if (groupElement instanceof HTMLElement) {
        const logLineElement = this.entryFormatter.format(logMessage);
        if (!logLineElement) {
          return true;
        }

        if (!(logLineElement instanceof HTMLElement)) {
          return false;
        }

        logLineElement.setAttribute('slot', 'children');

        // Extract timestamp from the message for chronological ordering
        const msgDate = new Date(logMessage.timestamp);

        insertChronologically({
          container: groupElement,
          element: logLineElement,
          timestamp: msgDate,
        });

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

      if (existing instanceof HTMLElement && newEl instanceof HTMLElement) {
        const slotName = existing.getAttribute('slot');
        if (slotName) {
          newEl.setAttribute('slot', slotName);
        }
      }

      existing.replaceWith(newEl);
      return true;
    }
    return false;
  }
}
