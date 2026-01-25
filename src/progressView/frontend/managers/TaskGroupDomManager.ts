// @ts-nocheck
// Local imports - progress view
import { ELEMENT_IDS, GROUP_DOM_IDS, STREAM_STATUS } from '../constants';
import {
  TaskGroupHeaderFormatter,
  getSharedLogEntryFormatter,
} from '../formatters';
import { insertChronologically } from '../utils';

// Local imports - common helpers
import { createFromTemplate } from '@common/modules/templateUtils.js';
import { ToggleStateStore } from '@common/modules/ToggleStateStore.js';

export class TaskGroupDomManager {
  constructor(toggleStates, root) {
    this.headerFormatter = new TaskGroupHeaderFormatter();
    this.previousActiveGroupId = null;
    this.groupElements = new Map();
    this._rootGroupIds = new Set();
    this.toggleListeners = new Map();
    this.taskGroups = new Map();
    this.currentGroupId = null;
    this.activeAgentCategory = 'workflow';
    this.toggleStates = toggleStates ?? new ToggleStateStore();
    this.root = root ?? document;
  }

  setActiveAgentCategory(category) {
    this.activeAgentCategory = category || 'workflow';
  }

  renderInitial(groups, container) {
    if (!Array.isArray(groups) || groups.length === 0 || !container) {
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
      this.currentGroupId = topLevel.at(-1).id;
      this.collapsePreviousActiveGroup();
    }
  }

  addGroup(group) {
    const existingElement = this.groupElements.get(group.id);
    if (existingElement) {
      this.taskGroups.set(group.id, group);
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
      this.currentGroupId = group.id;
      this.collapsePreviousActiveGroup();
    }
  }

  updateGroup(update) {
    if (!update || typeof update !== 'object') return;
    const { id, status, endTime } = update;
    if (!id) return;

    const group = this.taskGroups.get(id);
    if (!group) return;
    if (status) group.status = status;
    if (endTime != null) group.endTime = endTime;
    this.taskGroups.set(id, group);

    const header = this._getById(`${GROUP_DOM_IDS.HEADER_PREFIX}${id}`);
    if (!header) return;

    const statusIconElem = header.querySelector('.group-status-icon');
    if (statusIconElem) {
      statusIconElem.innerHTML = this.headerFormatter._getStatusIcon(
        group.status,
      );
    }

    header.className = this.headerFormatter._getHeaderClass(group, {
      cssClass: group.parentGroupId ? null : 'top-level',
    });

    const durationElem = header.querySelector('.group-duration');
    if (durationElem) {
      if (group.endTime) {
        const durationMs = group.endTime - group.startTime;
        durationElem.textContent =
          this.headerFormatter._formatDuration(durationMs);
      } else {
        durationElem.textContent = '';
      }
    }
  }

  showRun(groupId) {
    const showAll =
      this.activeAgentCategory === 'toolUse' ||
      !groupId ||
      !this._rootGroupIds.has(groupId);

    for (const id of this._rootGroupIds) {
      const element = this.groupElements.get(id);
      if (element) {
        element.hidden = !showAll && id !== groupId;
      }
    }
  }

  collapsePreviousActiveGroup() {
    const currentId = this.findCurrentActiveGroup();
    if (
      this.previousActiveGroupId &&
      this.previousActiveGroupId !== currentId
    ) {
      const previousElement = this.groupElements.get(
        this.previousActiveGroupId,
      );
      const previousGroup = this.taskGroups.get(this.previousActiveGroupId);
      if (previousElement && previousGroup?.parentGroupId) {
        this.collapseGroupAndChildren(this.previousActiveGroupId);
      }
    }
    this.previousActiveGroupId = currentId;
  }

  collapseGroupAndChildren(groupId) {
    for (const [childId, group] of this.taskGroups.entries()) {
      if (group.parentGroupId === groupId) {
        this.collapseGroupAndChildren(childId);
      }
    }

    const detailsElem = this.groupElements.get(groupId);
    if (detailsElem instanceof HTMLDetailsElement) {
      detailsElem.open = false;
      this.toggleStates.set(groupId, true);
    }
  }

  findCurrentActiveGroup() {
    const current = this.taskGroups.get(this.currentGroupId);
    if (current) return current.id;

    let latestGroup = null;
    let latestTime = 0;
    for (const [id, element] of this.groupElements.entries()) {
      if (!element) continue;
      const group = this.taskGroups.get(id);
      if (!group) continue;

      const isRootGroup = !group.parentGroupId;
      const isVisible = isRootGroup
        ? !element.hidden
        : element instanceof HTMLDetailsElement && element.open === true;
      if (!isVisible) continue;

      if (group.startTime > latestTime) {
        latestGroup = id;
        latestTime = group.startTime;
      }
    }

    return latestGroup;
  }

  clear() {
    for (const groupId of this.groupElements.keys()) {
      this._removeToggleListener(groupId);
    }
    this.groupElements.clear();
    this._rootGroupIds.clear();
    this.toggleListeners.clear();
    this.taskGroups.clear();
    this.previousActiveGroupId = null;
  }

  getGroupContainer(groupId) {
    const groupContentId = `${GROUP_DOM_IDS.CONTENT_PREFIX}${groupId}`;
    return this._getById(groupContentId);
  }

  _createGroupElement(group) {
    const baseGroupElement = createFromTemplate('groupDetailsTemplate');
    if (!baseGroupElement) return null;

    const groupContainer = baseGroupElement.querySelector('.log-group-content');
    if (!groupContainer) return null;
    groupContainer.id = `${GROUP_DOM_IDS.CONTENT_PREFIX}${group.id}`;

    if (!group.parentGroupId) {
      baseGroupElement.id = `${GROUP_DOM_IDS.DETAILS_PREFIX}${group.id}`;
      baseGroupElement.classList.add('log-run');
      baseGroupElement.dataset.runId = group.id;
      this._registerGroupElement(group, baseGroupElement);
      return baseGroupElement;
    }

    return this._createChildGroupElement(group, groupContainer);
  }

  _createChildGroupElement(group, groupContainer) {
    const headerElement = this.headerFormatter.create(group);
    if (!headerElement) return null;

    const detailsElem = document.createElement('details');
    detailsElem.className = 'log-group';
    detailsElem.id = `${GROUP_DOM_IDS.DETAILS_PREFIX}${group.id}`;
    detailsElem.appendChild(headerElement);
    detailsElem.appendChild(groupContainer);

    this._setupToggleState(group.id, detailsElem);
    this._registerGroupElement(group, detailsElem);
    return detailsElem;
  }

  _setupToggleState(groupId, detailsElem) {
    const isCollapsed = this.toggleStates.get(groupId) === true;
    detailsElem.open = !isCollapsed;

    const toggleListener = () => {
      this.toggleStates.set(groupId, !detailsElem.open);
    };
    detailsElem.addEventListener('toggle', toggleListener);
    this.toggleListeners.set(groupId, toggleListener);
  }

  _registerGroupElement(group, element) {
    this.taskGroups.set(group.id, group);
    this.groupElements.set(group.id, element);
    if (!group.parentGroupId) {
      this._rootGroupIds.add(group.id);
    }
  }

  _resolveGroupContent(parentGroupId) {
    if (!parentGroupId) {
      return this._getById(ELEMENT_IDS.LOG_CONTENT);
    }
    const parentDetails = this.groupElements.get(parentGroupId);
    return parentDetails?.querySelector('.log-group-content') ?? null;
  }

  _getById(id) {
    if (this.root && this.root !== document) {
      if (this.root instanceof Element) {
        return this.root.querySelector(`#${CSS.escape(id)}`);
      }
    }
    return document.getElementById(id);
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
    if (!groupId) return;
    this._removeToggleListener(groupId);
    this.groupElements.delete(groupId);
    this._rootGroupIds.delete(groupId);
    this.taskGroups.delete(groupId);
  }
}

export class LogEntryManager {
  constructor(root) {
    this.entryFormatter = getSharedLogEntryFormatter();
    this.logElements = new Map();
    this.root = root ?? document;
  }

  append(logMessage, options = {}) {
    if (logMessage.groupId) {
      const groupContentId = `${GROUP_DOM_IDS.CONTENT_PREFIX}${logMessage.groupId}`;
      const groupContent = this._getById(groupContentId);
      if (groupContent) {
        const logLineElement = this.entryFormatter.format(logMessage, options);
        if (!logLineElement) {
          return true;
        }

        if (logMessage.id) {
          this.logElements.set(logMessage.id, logLineElement);
        }

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

  update(logMessage) {
    let existing = this.logElements.get(logMessage.id);
    if (!existing) {
      existing =
        this.root instanceof Element
          ? this.root.querySelector(`[data-log-id="${logMessage.id}"]`)
          : document.querySelector(`[data-log-id="${logMessage.id}"]`);
      if (existing) {
        this.logElements.set(logMessage.id, existing);
      }
    }

    if (existing) {
      const wasOpen = existing.hasAttribute('open');
      const newEl = this.entryFormatter.format(logMessage, {
        preservedOpen: wasOpen,
      });
      if (!newEl) {
        existing.remove();
        this.logElements.delete(logMessage.id);
        return true;
      }

      existing.replaceWith(newEl);
      this.logElements.set(logMessage.id, newEl);
      return true;
    }
    return false;
  }

  clear() {
    this.logElements.clear();
  }

  _getById(id) {
    if (this.root && this.root !== document) {
      if (this.root instanceof Element) {
        return this.root.querySelector(`#${CSS.escape(id)}`);
      }
    }
    return document.getElementById(id);
  }
}
