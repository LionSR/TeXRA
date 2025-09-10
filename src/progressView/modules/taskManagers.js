// Local imports - progress view
import { ELEMENT_IDS } from './constants.js';
import { TaskGroupHeaderFormatter, LogEntryFormatter } from './formatters.js';
// Local imports
import { progressViewState } from './progressViewState.js';
import { insertChronologically } from './utils.js';
import { safeGetElementById } from '@common/domUtils.js';

/**
 * Manages task group DOM operations.
 */
export class TaskGroupManager {
  constructor() {
    this.headerFormatter = new TaskGroupHeaderFormatter();
    this.previousActiveGroupId = null;
  }

  /**
   * Adds a log group to the DOM
   * @param {Object} group - Group data
   */
  add(group) {
    // Check if this specific group (by ID) already exists in the DOM
    // This prevents duplicate groups from race conditions between UPDATE_LOGS and ADD_TASK_GROUP
    const existingGroup = safeGetElementById(`group-${group.id}`);
    if (existingGroup) {
      // Verify the group also exists in memory state
      if (!progressViewState.taskGroups.get(group.id)) {
        console.warn(
          `Group ${group.id} exists in DOM but not in state - removing from DOM`,
        );
        existingGroup.remove();
        // Continue with normal add flow to recreate it
      } else {
        // Group already exists in both DOM and state
        // Update the state with new group data
        progressViewState.taskGroups.set(group.id, group);
        // For now, just update status/endTime in DOM to prevent duplicates
        // TODO: Implement full property update to handle name/startTime/parentGroupId changes
        this.update(group.id, group.status, group.endTime);
        return;
      }
    }

    // Group doesn't exist in DOM (either new or was cleaned up above)
    // Add to state
    progressViewState.taskGroups.set(group.id, group);

    // Create the details container that will manage toggle state
    const detailsElem = document.createElement('details');
    detailsElem.className = 'log-group';
    detailsElem.id = `group-${group.id}`;

    // Create the header element as a <summary>
    const headerElement = this.headerFormatter.create(group);

    // Create a container for the group's messages
    const groupContainer = document.createElement('div');
    groupContainer.className = 'log-group-content';
    groupContainer.id = `group-content-${group.id}`;

    // Check if we have a saved collapsed state for this group
    const isCollapsed = progressViewState.toggleStates.get(group.id);
    detailsElem.open = isCollapsed !== true;

    detailsElem.appendChild(headerElement);
    detailsElem.appendChild(groupContainer);

    // Add toggle state tracking
    detailsElem.addEventListener('toggle', () => {
      progressViewState.toggleStates.set(group.id, !detailsElem.open);
    });

    // Insert the group at the right position in the parent
    const container = safeGetElementById(ELEMENT_IDS.LOG_CONTENT);

    if (group.parentGroupId) {
      // Find the parent group and append to its content container
      const parentGroupContent = safeGetElementById(
        `group-content-${group.parentGroupId}`,
      );
      if (parentGroupContent) {
        insertChronologically(parentGroupContent, detailsElem, group.startTime);
        return;
      }
    }

    // For top-level groups, insert in chronological order
    insertChronologically(container, detailsElem, group.startTime);

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
  update(groupId, status, endTime) {
    const group = progressViewState.taskGroups.get(groupId);
    if (!group) return;

    group.status = status;
    if (endTime) {
      group.endTime = endTime;
    }

    // Update the header in the UI if it exists
    const header = safeGetElementById(`group-header-${groupId}`);
    if (header) {
      const level = this.headerFormatter._getGroupLevel(group);
      header.className = this.headerFormatter._getHeaderClass(group, level);

      // Update the status icon
      const statusIconElem = header.querySelector('.group-status-icon');
      if (statusIconElem) {
        statusIconElem.innerHTML = this.headerFormatter._getStatusIcon(status);
      }

      // Update or add the duration display when the group finishes
      const timeContainer = header.querySelector('.group-time');

      if (endTime) {
        const endDate = endTime;
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
  }

  /**
   * Collapse a group and all of its child groups recursively
   * @private
   * @param {string} groupId - ID of the group to collapse
   */
  collapseGroupAndChildren(groupId) {
    // Find all child groups
    for (const [childId, group] of progressViewState.taskGroups.getAll()) {
      if (group.parentGroupId === groupId) {
        this.collapseGroupAndChildren(childId);
      }
    }

    // Collapse this group
    const detailsElem = safeGetElementById(`group-${groupId}`);
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

    for (const [id, group] of progressViewState.taskGroups.getAll()) {
      const detailsElem = safeGetElementById(`group-${id}`);
      if (detailsElem && detailsElem.open && group.startTime > latestTime) {
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
      const groupContent = safeGetElementById(
        `group-content-${logMessage.groupId}`,
      );
      if (groupContent) {
        const logLineElement = this.entryFormatter.format(logMessage);

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
