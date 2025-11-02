// Local imports - progress view
import { ELEMENT_IDS, GROUP_DOM_IDS } from './constants.js';
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
    this.toggleListeners = new Map();
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
        this._removeToggleListener(group.id);
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

    const detailsElem = createFromTemplate('groupDetailsTemplate');
    if (!detailsElem) {
      console.error(
        'TaskGroupDomManager.addGroup: groupDetailsTemplate not found',
      );
      return;
    }
    detailsElem.id = `${GROUP_DOM_IDS.DETAILS_PREFIX}${group.id}`;

    const headerElement = this.headerFormatter.create(group);
    if (!headerElement) {
      console.error(
        'TaskGroupDomManager.addGroup: failed to create group header',
      );
      detailsElem.remove();
      return;
    }

    const groupContainer = detailsElem.querySelector('.log-group-content');
    if (!groupContainer) {
      console.error(
        'TaskGroupDomManager.addGroup: missing group content container',
      );
      detailsElem.remove();
      return;
    }
    groupContainer.id = `${GROUP_DOM_IDS.CONTENT_PREFIX}${group.id}`;

    progressViewState.taskGroups.set(group.id, group);

    const isCollapsed = progressViewState.toggleStates.get(group.id);
    detailsElem.open = isCollapsed !== true;

    detailsElem.prepend(headerElement);

    const toggleListener = () => {
      progressViewState.toggleStates.set(group.id, !detailsElem.open);
    };
    detailsElem.addEventListener('toggle', toggleListener);
    this.toggleListeners.set(group.id, toggleListener);

    this.groupElements.set(group.id, detailsElem);

    // Insert the group at the right position in the parent
    const container = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    if (!container) {
      console.error(
        'TaskGroupDomManager.addGroup: missing log content container',
      );
      this._removeToggleListener(group.id);
      this.groupElements.delete(group.id);
      return;
    }

    if (group.parentGroupId) {
      const parentDetails = this.groupElements.get(group.parentGroupId);
      const parentGroupContent =
        parentDetails?.querySelector('.log-group-content');
      if (parentGroupContent) {
        insertChronologically({
          container: parentGroupContent,
          element: detailsElem,
          timestamp: group.startTime,
        });
        return;
      }
    }

    // For top-level groups, insert in chronological order
    insertChronologically({
      container,
      element: detailsElem,
      timestamp: group.startTime,
    });

    // For top-level groups, update current group and collapse the previous active group
    if (!group.parentGroupId) {
      progressViewState.currentGroupId = group.id;
      this.collapsePreviousActiveGroup();
    }
  }

  /**
   * Updates the UI of a log group's header
   * @param {string} groupId - ID of the group to update
   * @param {string} status - New status
   * @param {string} endTime - End time (optional)
   */
  updateGroup(update) {
    const { groupId, updates = {} } = update ?? {};
    const group = progressViewState.taskGroups.get(groupId);
    if (!group) return;

    const hasStatusUpdate = 'status' in updates;
    const hasEndTimeUpdate = 'endTime' in updates;

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

    const detailsElem = this.groupElements.get(groupId);
    if (!detailsElem) {
      return;
    }

    const header = detailsElem.querySelector('.log-group-header');
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
    const detailsElem = this.groupElements.get(groupId);
    if (detailsElem) {
      detailsElem.open = false;
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

    for (const [id, detailsElem] of this.groupElements.entries()) {
      if (!detailsElem || !detailsElem.open) {
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
    for (const groupId of this.groupElements.keys()) {
      this._removeToggleListener(groupId);
    }
    this.groupElements.clear();
    this.toggleListeners.clear();
    this.previousActiveGroupId = null;
  }

  _removeToggleListener(groupId) {
    const listener = this.toggleListeners.get(groupId);
    const element = this.groupElements.get(groupId);
    if (listener && element) {
      element.removeEventListener('toggle', listener);
    }
    this.toggleListeners.delete(groupId);
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
      const groupContentId = `${GROUP_DOM_IDS.CONTENT_PREFIX}${logMessage.groupId}`;
      const groupContent = document.getElementById(groupContentId);
      if (groupContent) {
        const logLineElement = this.entryFormatter.format(logMessage);
        if (!logLineElement) {
          console.debug(
            'LogEntryManager.append: formatter returned null for message',
            logMessage,
          );
          return true;
        }

        // Extract timestamp from the message for chronological ordering
        const msgDate = new Date(logMessage.timestamp);

        insertChronologically({
          container: groupContent,
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

      existing.replaceWith(newEl);
      return true;
    }
    return false;
  }
}
