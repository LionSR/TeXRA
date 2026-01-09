// Local imports - progress view
import { ELEMENT_IDS } from '../constants.js';
import { getDateTimeFormatter } from '../formatters/timestampUtils.js';
// Local imports - shared helpers
import { safeGetElementById } from '@common/domUtils.js';

/**
 * Manages the run selector dropdown in the progress view header.
 */
export class RunSelector {
  constructor() {
    this._dropdown = null;
    this._container = null;
    this._runs = new Map();
    this._onDidChange = null;
    this._changeHandler = this._handleChange.bind(this);
    this._pendingActiveId = null;
    this._isDisplayEnabled = true;
    this._domReady = document.readyState !== 'loading';
    this._initScheduled = false;

    if (this._domReady) {
      this._scheduleInitialize();
    } else {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          this._domReady = true;
          this.initialize();
        },
        { once: true },
      );
    }
  }

  initialize() {
    if (!this._domReady) {
      this._initScheduled = false;
      return;
    }

    this._initScheduled = false;
    this._initializeDropdown();
    this._syncVisibility();
  }

  _scheduleInitialize() {
    if (this._initScheduled) {
      return;
    }

    if (!this._domReady) {
      return;
    }

    this._initScheduled = true;
    queueMicrotask(() => {
      if (!this._domReady) {
        this._initScheduled = false;
        return;
      }
      this.initialize();
    });
  }

  _initializeDropdown() {
    if (!this._domReady) {
      return;
    }

    if (this._dropdown) {
      this._dropdown.removeEventListener('change', this._changeHandler);
      this._dropdown = null;
    }

    const container = safeGetElementById(ELEMENT_IDS.RUN_SELECTOR_CONTAINER);
    if (container) {
      this._container = container;
    }
    const dropdown = safeGetElementById(ELEMENT_IDS.RUN_SELECTOR);
    if (!dropdown) {
      return;
    }

    dropdown.addEventListener('change', this._changeHandler);
    this._dropdown = dropdown;
    this._renderOptions();
  }

  _ensureDropdown() {
    if (this._dropdown) {
      return true;
    }

    if (!this._domReady) {
      this._scheduleInitialize();
      return false;
    }

    this._initializeDropdown();
    return Boolean(this._dropdown);
  }

  _handleChange() {
    if (!this._dropdown) {
      return;
    }

    const value = this._dropdown.value;
    this._pendingActiveId = value || null;
    if (this._onDidChange) {
      this._onDidChange(this._pendingActiveId);
    }
  }

  onDidChange(callback) {
    this._onDidChange = typeof callback === 'function' ? callback : null;
    return () => {
      if (this._onDidChange === callback) {
        this._onDidChange = null;
      }
    };
  }

  addRun(group) {
    if (!group || !group.id) {
      return;
    }

    this._runs.set(group.id, {
      id: group.id,
      name: group.name,
      startTime: group.startTime,
    });

    if (this._ensureDropdown()) {
      this._renderOptions();
    }

    this._syncVisibility();
  }

  setRuns(groups = []) {
    this._runs.clear();
    groups.forEach((group) => {
      if (group && group.id) {
        this._runs.set(group.id, {
          id: group.id,
          name: group.name,
          startTime: group.startTime,
        });
      }
    });

    if (this._ensureDropdown()) {
      this._renderOptions();
    }

    this._syncVisibility();
  }

  setActiveRun(groupId) {
    this._pendingActiveId = groupId || null;
    if (this._ensureDropdown()) {
      this._applyActiveValue();
    }
  }

  getActiveRunId() {
    if (this._dropdown) {
      return this._dropdown.value || null;
    }
    return this._pendingActiveId;
  }

  removeRun(groupId) {
    if (!groupId) {
      return;
    }

    this._runs.delete(groupId);
    if (this._pendingActiveId === groupId) {
      this._pendingActiveId = null;
    }

    if (this._ensureDropdown()) {
      this._renderOptions();
    }

    this._syncVisibility();
  }

  clear() {
    this._runs.clear();
    this._pendingActiveId = null;

    if (this._dropdown) {
      this._dropdown.innerHTML = '';
      this._dropdown.value = '';
    }

    this._syncVisibility();
  }

  _renderOptions() {
    if (!this._dropdown) {
      return;
    }

    const runs = this._getSortedRuns();
    const targetId = this._resolveTargetId(runs);

    const fragment = document.createDocumentFragment();
    runs.forEach((group) => {
      const option = document.createElement('vscode-option');
      option.value = group.id;
      option.textContent = this._formatRunLabel(group);
      if (group.id === targetId) {
        option.selected = true;
      }
      fragment.appendChild(option);
    });

    this._dropdown.innerHTML = '';
    this._dropdown.appendChild(fragment);
    this._pendingActiveId = targetId || null;
  }

  _resolveTargetId(runs) {
    let targetId = this._pendingActiveId;
    if (targetId && !this._runs.has(targetId)) {
      targetId = null;
    }
    if (!targetId && runs && runs.length > 0) {
      targetId = runs.at(-1).id;
    }
    return targetId;
  }

  _applyActiveValue() {
    if (!this._dropdown) {
      return;
    }

    const targetId = this._resolveTargetId(this._getSortedRuns());

    // Setting .selected on existing options doesn't trigger slotchange.
    // We must set .value to update the component's displayed selection.
    this._dropdown.value = targetId ?? '';
    this._pendingActiveId = this._dropdown.value || null;
  }

  _getSortedRuns() {
    return Array.from(this._runs.values()).sort((a, b) => {
      const aTime =
        typeof a.startTime === 'number'
          ? a.startTime
          : a.startTime
            ? Date.parse(a.startTime)
            : 0;
      const bTime =
        typeof b.startTime === 'number'
          ? b.startTime
          : b.startTime
            ? Date.parse(b.startTime)
            : 0;
      const safeATime = Number.isNaN(aTime) ? 0 : aTime;
      const safeBTime = Number.isNaN(bTime) ? 0 : bTime;
      if (safeATime === safeBTime) {
        return a.id.localeCompare(b.id);
      }
      return safeATime - safeBTime;
    });
  }

  _formatRunLabel(group) {
    const timestamp = this._formatTimestamp(group.startTime);
    if (timestamp) {
      return timestamp;
    }
    return group.name ?? 'Session';
  }

  _formatTimestamp(value) {
    if (!value) {
      return '';
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }

    return getDateTimeFormatter().format(date);
  }

  _syncVisibility() {
    const hasRuns = this._runs.size > 0 && this._isDisplayEnabled;

    if (hasRuns) {
      this._ensureDropdown();
    }

    if (!this._container && this._domReady) {
      const containerElem = safeGetElementById(
        ELEMENT_IDS.RUN_SELECTOR_CONTAINER,
      );
      if (containerElem) {
        this._container = containerElem;
      }
    }

    const container = this._container;
    if (container) {
      container.toggleAttribute('hidden', !hasRuns);
      container.setAttribute('aria-hidden', hasRuns ? 'false' : 'true');
    }

    const dropdown = this._dropdown;
    if (dropdown) {
      dropdown.disabled = !hasRuns;
      dropdown.hidden = !hasRuns;
      dropdown.setAttribute('aria-hidden', hasRuns ? 'false' : 'true');
    }
  }

  setDisplayEnabled(shouldDisplay) {
    this._isDisplayEnabled = Boolean(shouldDisplay);
    this._syncVisibility();
  }

  cleanup() {
    if (this._dropdown) {
      this._dropdown.removeEventListener('change', this._changeHandler);
    }
    this._dropdown = null;
    this._container = null;
    this._runs.clear();
    this._onDidChange = null;
    this._pendingActiveId = null;
    this._isDisplayEnabled = true;
    this._initScheduled = false;
  }
}
