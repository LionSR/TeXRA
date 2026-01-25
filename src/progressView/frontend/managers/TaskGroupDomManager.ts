// Local imports - Lit template utilities
import { ToggleStateStore } from '@shared/state/ToggleStateStore';
import { html, render, renderToElement } from '../formatters/litTemplates';

// Local imports - shared state

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
    this.toggleStates = toggleStates ?? new ToggleStateStore();
    this.root = root ?? document;
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
      if (!parentId) continue;

      const children = childrenByParent.get(parentId);
      if (!children?.length) continue;

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

    // Update status icon using Lit render
    const statusIconElem = header.querySelector('.group-status-icon');
    if (statusIconElem instanceof HTMLElement) {
      render(this.headerFormatter._getStatusIcon(group.status), statusIconElem);
    }

    header.className = this.headerFormatter._getHeaderClass(
      group,
      this.headerFormatter._getGroupLevel(group),
    );

    // Update duration
    const durationElem = header.querySelector('.group-duration');
    if (durationElem) {
      const durationMs = group.endTime ? group.endTime - group.startTime : null;
      durationElem.textContent = durationMs
        ? this.headerFormatter._formatDuration(durationMs)
        : '';
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

  /**
   * Show/hide run groups based on selection.
   * @param groupId - The run group to show, or null to show all
   * @param isToolUse - If true, always show all runs (tool-use agents don't filter by run)
   */
  showRun(groupId: string | null, isToolUse = false): void {
    const showAll = isToolUse || !groupId || !this._rootGroupIds.has(groupId);

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
    const contentId = `${GROUP_DOM_IDS.CONTENT_PREFIX}${group.id}`;

    // Root groups: simple container div
    if (!group.parentGroupId) {
      const element = renderToElement(html`
        <div
          id=${`${GROUP_DOM_IDS.DETAILS_PREFIX}${group.id}`}
          class="log-group log-run"
          data-run-id=${group.id}
        >
          <div id=${contentId} class="log-group-content"></div>
        </div>
      `);
      if (!element) return null;
      this._registerGroupElement(group, element);
      return element;
    }

    // Child groups: details element with header
    return this._createChildGroupElement(group, contentId);
  }

  _createChildGroupElement(
    group: TaskGroup,
    contentId: string,
  ): HTMLElement | null {
    const headerElement = this.headerFormatter.create(group);
    if (!headerElement) return null;

    // Create details element using Lit template
    const detailsElem = renderToElement(html`
      <details
        id=${`${GROUP_DOM_IDS.DETAILS_PREFIX}${group.id}`}
        class="log-group"
      >
        <div id=${contentId} class="log-group-content"></div>
      </details>
    `) as HTMLDetailsElement | null;

    if (!detailsElem) return null;

    // Insert header before content
    detailsElem.insertBefore(headerElement, detailsElem.firstChild);

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
    return this.root instanceof Element
      ? this.root.querySelector(`#${CSS.escape(id)}`)
      : document.getElementById(id);
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
    return this.root instanceof Element
      ? this.root.querySelector(`#${CSS.escape(id)}`)
      : document.getElementById(id);
  }
}
