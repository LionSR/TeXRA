// Local imports - common helpers
import { createFromTemplate } from '@common/modules/templateUtils.js';
import { ToggleStateStore } from '@common/modules/ToggleStateStore.js';

// Local imports - progress view constants
import { ELEMENT_IDS, GROUP_DOM_IDS, STREAM_STATUS } from '../constants';

// Local imports - progress view formatters
import {
  TaskGroupHeaderFormatter,
  getSharedLogEntryFormatter,
  type LogEntryFormatter,
} from '../formatters';

// Local imports - progress view helpers
import { insertChronologically } from '../utils';

// Local imports - shared schemas
import type { LogMessageData, TaskGroup } from '@shared/schemas';

type ToggleListener = (event: Event) => void;
type RootElement = Document | Element;
type LogFormatOptions = {
  preservedOpen?: boolean;
  defaultOpen?: boolean;
};

export class TaskGroupDomManager {
  private headerFormatter: TaskGroupHeaderFormatter;
  private previousActiveGroupId: string | null;
  private groupElements: Map<string, HTMLElement>;
  private _rootGroupIds: Set<string>;
  private toggleListeners: Map<string, ToggleListener>;
  private taskGroups: Map<string, TaskGroup>;
  private currentGroupId: string | null;
  private activeAgentCategory: string;
  private toggleStates: ToggleStateStore;
  private root: RootElement;

  constructor(toggleStates?: ToggleStateStore, root?: RootElement) {
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

  setActiveAgentCategory(category: string): void {
    this.activeAgentCategory = category || 'workflow';
  }

  renderInitial(groups: TaskGroup[], container: HTMLElement | null): void {
    if (!Array.isArray(groups) || groups.length === 0 || !container) {
      return;
    }

    const topLevel: TaskGroup[] = [];
    const childrenByParent = new Map<string, TaskGroup[]>();
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
    const traversalQueue: string[] = [];
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
      if (!parentId) {
        continue;
      }
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

    const lastTop = topLevel.at(-1);
    if (lastTop) {
      this.currentGroupId = lastTop.id;
      this.collapsePreviousActiveGroup();
    }
  }

  addGroup(group: TaskGroup): void {
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

  updateGroup(update: Partial<TaskGroup> & { id: string }): void {
    if (!update || typeof update !== 'object') return;
    const { id, status, endTime } = update;
    if (!id) return;

    const group = this.taskGroups.get(id);
    if (!group) return;

    const wasRunning = group.status === STREAM_STATUS.RUNNING;
    const isNowComplete =
      status === STREAM_STATUS.READY || status === STREAM_STATUS.STOPPED;

    if (status) group.status = status;
    if (endTime !== null && endTime !== undefined) {
      group.endTime = endTime;
    }
    this.taskGroups.set(id, group);

    // Play sound when a run group completes (name matches r1, r2, etc.)
    if (wasRunning && isNowComplete && /^r\d+$/.test(group.name)) {
      this.playSystemSound();
    }

    const header = this._getById(`${GROUP_DOM_IDS.HEADER_PREFIX}${id}`);
    if (!header) return;

    const statusIconElem = header.querySelector('.group-status-icon');
    if (statusIconElem) {
      statusIconElem.innerHTML = this.headerFormatter._getStatusIcon(
        group.status,
      );
    }

    header.className = this.headerFormatter._getHeaderClass(
      group,
      this.headerFormatter._getGroupLevel(group),
    );

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

  /**
   * Plays a short system beep to notify the user that a run has completed.
   */
  playSystemSound(): void {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtx) return;

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
    } catch {
      // Ignore errors (e.g., autoplay restrictions)
    }
  }

  showRun(groupId: string | null): void {
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

  collapsePreviousActiveGroup(): void {
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

  collapseGroupAndChildren(groupId: string): void {
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

  findCurrentActiveGroup(): string | null {
    const current = this.currentGroupId
      ? this.taskGroups.get(this.currentGroupId)
      : undefined;
    if (current) return current.id;

    let latestGroup: string | null = null;
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

  clear(): void {
    for (const groupId of this.groupElements.keys()) {
      this._removeToggleListener(groupId);
    }
    this.groupElements.clear();
    this._rootGroupIds.clear();
    this.toggleListeners.clear();
    this.taskGroups.clear();
    this.previousActiveGroupId = null;
  }

  getGroupContainer(groupId: string): HTMLElement | null {
    const groupContentId = `${GROUP_DOM_IDS.CONTENT_PREFIX}${groupId}`;
    return this._getById(groupContentId);
  }

  _createGroupElement(group: TaskGroup): HTMLElement | null {
    const baseGroupElement = createFromTemplate('groupDetailsTemplate');
    if (!baseGroupElement) return null;

    const groupContainer = baseGroupElement.querySelector('.log-group-content');
    if (!(groupContainer instanceof HTMLElement)) return null;
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

  _createChildGroupElement(
    group: TaskGroup,
    groupContainer: HTMLElement,
  ): HTMLElement | null {
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

  _setupToggleState(groupId: string, detailsElem: HTMLDetailsElement): void {
    const isCollapsed = this.toggleStates.get(groupId) === true;
    detailsElem.open = !isCollapsed;

    const toggleListener: ToggleListener = () => {
      this.toggleStates.set(groupId, !detailsElem.open);
    };
    detailsElem.addEventListener('toggle', toggleListener);
    this.toggleListeners.set(groupId, toggleListener);
  }

  _registerGroupElement(group: TaskGroup, element: HTMLElement): void {
    this.taskGroups.set(group.id, group);
    this.groupElements.set(group.id, element);
    if (!group.parentGroupId) {
      this._rootGroupIds.add(group.id);
    }
  }

  _resolveGroupContent(parentGroupId?: string | null): HTMLElement | null {
    if (!parentGroupId) {
      return this._getById(ELEMENT_IDS.LOG_CONTENT);
    }
    const parentDetails = this.groupElements.get(parentGroupId);
    const content = parentDetails?.querySelector('.log-group-content');
    return content instanceof HTMLElement ? content : null;
  }

  _getById(id: string): HTMLElement | null {
    if (this.root && this.root !== document) {
      if (this.root instanceof Element) {
        return this.root.querySelector(`#${CSS.escape(id)}`);
      }
    }
    return document.getElementById(id);
  }

  _removeToggleListener(groupId: string): void {
    const listener = this.toggleListeners.get(groupId);
    const element = this.groupElements.get(groupId);
    if (listener && element) {
      element.removeEventListener('toggle', listener);
    }
    this.toggleListeners.delete(groupId);
  }

  _discardGroup(groupId: string): void {
    if (!groupId) return;
    this._removeToggleListener(groupId);
    this.groupElements.delete(groupId);
    this._rootGroupIds.delete(groupId);
    this.taskGroups.delete(groupId);
  }
}

export class LogEntryManager {
  entryFormatter: LogEntryFormatter;
  private logElements: Map<string, HTMLElement>;
  private root: RootElement;

  constructor(root?: RootElement) {
    this.entryFormatter = getSharedLogEntryFormatter();
    this.logElements = new Map();
    this.root = root ?? document;
  }

  append(logMessage: LogMessageData, options: LogFormatOptions = {}): boolean {
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

  update(logMessage: LogMessageData): boolean {
    let existing = this.logElements.get(logMessage.id);
    if (!existing) {
      const found =
        this.root instanceof Element
          ? this.root.querySelector(`[data-log-id="${logMessage.id}"]`)
          : document.querySelector(`[data-log-id="${logMessage.id}"]`);
      if (found instanceof HTMLElement) {
        existing = found;
        this.logElements.set(logMessage.id, found);
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

  clear(): void {
    this.logElements.clear();
  }

  _getById(id: string): HTMLElement | null {
    if (this.root && this.root !== document) {
      if (this.root instanceof Element) {
        return this.root.querySelector(`#${CSS.escape(id)}`);
      }
    }
    return document.getElementById(id);
  }
}
