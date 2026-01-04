// Local imports - progress view
import { ELEMENT_IDS, GROUP_DOM_IDS } from './constants.js';
import {
  TaskGroupHeaderFormatter,
  getSharedLogEntryFormatter,
} from './formatters/index.js';
// Local imports
import { progressViewState } from './progressViewState.js';
import { insertChronologically } from './utils.js';
import { createFromTemplate } from '@common/templateUtils.js';

/**
 * Manages task group DOM operations.
 */
export class TaskGroupDomManager {
  constructor(runSelector) {
    this.headerFormatter = new TaskGroupHeaderFormatter();
    this.previousActiveGroupId = null;
    this.groupElements = new Map();
    this.toggleListeners = new Map();
    this.runSelector = runSelector || null;
  }

  _createGroupElement(group) {
    const baseGroupElement = createFromTemplate('groupDetailsTemplate');
    if (!baseGroupElement) {
      return null;
    }

    const groupContainer = baseGroupElement.querySelector('.log-group-content');
    if (!groupContainer) {
      return null;
    }
    groupContainer.id = `${GROUP_DOM_IDS.CONTENT_PREFIX}${group.id}`;

    let detailsElem;
    if (!group.parentGroupId) {
      detailsElem = baseGroupElement;
      detailsElem.id = `${GROUP_DOM_IDS.DETAILS_PREFIX}${group.id}`;
      detailsElem.classList.add('log-run');
      detailsElem.dataset.runId = group.id;
    } else {
      const headerElement = this.headerFormatter.create(group);
      if (!headerElement) {
        return null;
      }

      detailsElem = document.createElement('details');
      detailsElem.className = 'log-group';
      detailsElem.id = `${GROUP_DOM_IDS.DETAILS_PREFIX}${group.id}`;
      detailsElem.appendChild(headerElement);
      detailsElem.appendChild(groupContainer);

      const isCollapsed = progressViewState.toggleStates.get(group.id);
      detailsElem.open = isCollapsed !== true;

      const toggleListener = () => {
        progressViewState.toggleStates.set(group.id, !detailsElem.open);
      };
      detailsElem.addEventListener('toggle', toggleListener);
      this.toggleListeners.set(group.id, toggleListener);
    }

    progressViewState.taskGroups.set(group.id, group);
    this.groupElements.set(group.id, detailsElem);

    return detailsElem;
  }

  _resolveGroupContent(parentGroupId) {
    if (!parentGroupId) {
      return document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    }
    const parentDetails = this.groupElements.get(parentGroupId);
    return parentDetails?.querySelector('.log-group-content') ?? null;
  }

  renderInitial(groups) {
    if (!Array.isArray(groups) || groups.length === 0) {
      return;
    }

    const container = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    if (!container) {
      return;
    }

    const topLevel = [];
    const childrenByParent = new Map();
    for (const group of groups) {
      if (group.parentGroupId) {
        const parentId = group.parentGroupId;
        let bucket = childrenByParent.get(parentId);
        if (!bucket) {
          bucket = [];
          childrenByParent.set(parentId, bucket);
        }
        bucket.push(group);
      } else {
        topLevel.push(group);
      }
    }

    const fragment = document.createDocumentFragment();
    const traversalQueue = [];
    for (const group of topLevel) {
      const element = this._createGroupElement(group);
      if (!element) {
        this._discardGroup(group.id);
        continue;
      }
      fragment.appendChild(element);
      traversalQueue.push(group.id);
    }
    if (fragment.childNodes.length > 0) {
      container.appendChild(fragment);
    }

    while (traversalQueue.length > 0) {
      const parentId = traversalQueue.shift();
      const children = childrenByParent.get(parentId);
      if (!children || children.length === 0) {
        continue;
      }

      const parentContent = this._resolveGroupContent(parentId);
      if (!parentContent) {
        for (const child of children) {
          this._discardGroup(child.id);
        }
        childrenByParent.delete(parentId);
        continue;
      }

      const parentFragment = document.createDocumentFragment();
      for (const child of children) {
        const element = this._createGroupElement(child);
        if (!element) {
          this._discardGroup(child.id);
          continue;
        }
        parentFragment.appendChild(element);
        traversalQueue.push(child.id);
      }

      if (parentFragment.childNodes.length > 0) {
        parentContent.appendChild(parentFragment);
      }

      childrenByParent.delete(parentId);
    }

    if (childrenByParent.size > 0) {
      for (const orphans of childrenByParent.values()) {
        for (const orphan of orphans) {
          this._discardGroup(orphan.id);
        }
      }
    }

    if (topLevel.length > 0) {
      progressViewState.currentGroupId = topLevel.at(-1).id;
      this.collapsePreviousActiveGroup();
    }
  }

  /**
   * Adds a log group to the DOM
   * @param {Object} group - Group data
   */
  addGroup(group) {
    const existingElement = this.groupElements.get(group.id);
    if (existingElement) {
      progressViewState.taskGroups.set(group.id, group);
      if (group.parentGroupId) {
        this.updateGroup({
          id: group.id,
          status: group.status,
          endTime: group.endTime,
        });
      }
      return;
    }

    const element = this._createGroupElement(group);
    if (!element) {
      return;
    }

    const targetContainer = this._resolveGroupContent(group.parentGroupId);
    if (!targetContainer) {
      this._discardGroup(group.id);
      return;
    }

    insertChronologically({
      container: targetContainer,
      element,
      timestamp: group.startTime,
    });

    if (!group.parentGroupId) {
      progressViewState.currentGroupId = group.id;
      this.collapsePreviousActiveGroup();
    }
  }

  /**
   * Updates the UI of a log group's header.
   * Payload uses flat structure: { id, status, endTime } matching UpdateTaskGroupPayload.
   * @param {{ id: string, status?: string, endTime?: number }} update
   */
  updateGroup(update) {
    if (!update || typeof update !== 'object') {
      return;
    }

    const { id, status, endTime } = update;
    if (!id) {
      return;
    }

    const group = progressViewState.taskGroups.get(id);
    if (!group) return;

    const hasStatusUpdate = status !== undefined;
    const hasEndTimeUpdate = endTime !== undefined && endTime !== null;

    if (hasStatusUpdate && status) {
      group.status = status;
    }
    if (hasEndTimeUpdate) {
      group.endTime = endTime;
    }

    const detailsElem = this.groupElements.get(id);
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

      if (hasEndTimeUpdate) {
        const durationMs = group.endTime - group.startTime;

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

    progressViewState.taskGroups.set(id, group);
  }

  showRun(groupId) {
    const hasTarget = Boolean(groupId && this.groupElements.has(groupId));

    for (const [id, element] of this.groupElements.entries()) {
      if (!element) {
        continue;
      }

      const group = progressViewState.taskGroups.get(id);
      if (!group || group.parentGroupId) {
        continue;
      }

      const shouldShow = hasTarget ? id === groupId : true;
      element.hidden = !shouldShow;
    }
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
      if (detailsElem instanceof HTMLDetailsElement) {
        detailsElem.open = false;
        progressViewState.toggleStates.set(groupId, true);
      }
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

    for (const [id, element] of this.groupElements.entries()) {
      if (!element) {
        continue;
      }

      const group = progressViewState.taskGroups.get(id);
      if (!group) {
        continue;
      }

      const isRootGroup = !group.parentGroupId;
      if (isRootGroup) {
        if (element.hidden) {
          continue;
        }
      } else if (
        !(element instanceof HTMLDetailsElement) ||
        element.open !== true
      ) {
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
      const previousElement = this.groupElements.get(
        this.previousActiveGroupId,
      );
      const previousGroup = progressViewState.taskGroups.get(
        this.previousActiveGroupId,
      );
      if (previousElement && previousGroup?.parentGroupId) {
        this.collapseGroupAndChildren(this.previousActiveGroupId);
      }
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
    if (this.runSelector) {
      this.runSelector.clear();
    }
  }

  _removeToggleListener(groupId) {
    const listener = this.toggleListeners.get(groupId);
    const element = this.groupElements.get(groupId);
    if (listener && element) {
      element.removeEventListener('toggle', listener);
    }
    this.toggleListeners.delete(groupId);
  }

  _discardGroup(groupId) {
    if (!groupId) {
      return;
    }
    this._removeToggleListener(groupId);
    this.groupElements.delete(groupId);
    progressViewState.taskGroups.delete(groupId);
  }
}

/**
 * Manages individual log entry DOM operations.
 */
export class LogEntryManager {
  constructor() {
    this.entryFormatter = getSharedLogEntryFormatter();
  }

  /**
   * Appends a log message to its group or to the main content
   * @param {Object} logMessage - The log message to append
   * @returns {boolean} Whether the message was appended to a group
   */
  append(logMessage, options = {}) {
    // If the message has a group ID, append it to the right group
    if (logMessage.groupId) {
      const groupContentId = `${GROUP_DOM_IDS.CONTENT_PREFIX}${logMessage.groupId}`;
      const groupContent = document.getElementById(groupContentId);
      if (groupContent) {
        const logLineElement = this.entryFormatter.format(logMessage, options);
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
      const newEl = this.entryFormatter.format(logMessage, {
        preservedOpen: wasOpen,
      });
      if (!newEl) {
        existing.remove();
        return true;
      }

      existing.replaceWith(newEl);
      return true;
    }
    return false;
  }
}
