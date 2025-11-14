// Local imports - progress view
import { ELEMENT_IDS } from '../constants.js';
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
    this._labelFormatter = null;
    this._domReadyListenerRegistered = false;
    this._domReadyHandler = () => {
      this._domReadyListenerRegistered = false;
      this._initializeDomElements();
      this._syncVisibility();
    };
  }

  ensureInitialized() {
    if (this._dropdown) {
      return true;
    }

    if (document.readyState === 'loading') {
      if (!this._domReadyListenerRegistered) {
        document.addEventListener(
          'DOMContentLoaded',
          this._domReadyHandler,
          { once: true },
        );
        this._domReadyListenerRegistered = true;
      }
      return false;
    }

    this._initializeDomElements();
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

    const isInitialized = this.ensureInitialized();
    if (isInitialized) {
      this._renderOptions();
      this._applyActiveValue();
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

    const isInitialized = this.ensureInitialized();
    if (isInitialized) {
      this._renderOptions();
      this._applyActiveValue();
    }

    this._syncVisibility();
  }

  setActiveRun(groupId) {
    this._pendingActiveId = groupId || null;
    if (this.ensureInitialized()) {
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

    if (this.ensureInitialized()) {
      this._renderOptions();
      this._applyActiveValue();
    }

    this._syncVisibility();
  }

  clear() {
    this._runs.clear();
    this._pendingActiveId = null;

    if (this.ensureInitialized() && this._dropdown) {
      this._dropdown.innerHTML = '';
      this._dropdown.value = '';
    }

    this._syncVisibility();
  }

  _initializeDomElements() {
    const container = safeGetElementById(ELEMENT_IDS.RUN_SELECTOR_CONTAINER);
    if (container) {
      this._container = container;
    }

    const dropdown = safeGetElementById(ELEMENT_IDS.RUN_SELECTOR);
    if (!dropdown) {
      return;
    }

    if (this._dropdown && this._dropdown !== dropdown) {
      this._dropdown.removeEventListener('change', this._changeHandler);
    }

    if (this._dropdown !== dropdown) {
      dropdown.addEventListener('change', this._changeHandler);
    }

    this._dropdown = dropdown;
    this._renderOptions();
    this._applyActiveValue();
  }

  _renderOptions() {
    if (!this._dropdown) {
      return;
    }

    const fragment = document.createDocumentFragment();
    const runs = this._getSortedRuns();
    runs.forEach((group) => {
      const option = document.createElement('vscode-option');
      option.value = group.id;
      option.textContent = this._formatRunLabel(group);
      fragment.appendChild(option);
    });

    this._dropdown.innerHTML = '';
    this._dropdown.appendChild(fragment);
    this._applyActiveValue(runs);
  }

  _applyActiveValue(sortedRuns) {
    if (!this._dropdown) {
      return;
    }

    const runs = sortedRuns || this._getSortedRuns();

    let targetId = this._pendingActiveId;
    if (targetId && !this._runs.has(targetId)) {
      targetId = null;
    }

    if (!targetId && runs.length > 0) {
      targetId = runs[runs.length - 1].id;
    }

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
    return 'Session';
  }

  _formatTimestamp(value) {
    if (!value) {
      return '';
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }

    return this.getLabelFormatter().format(date);
  }

  _syncVisibility() {
    const hasRuns = this._runs.size > 0 && this._isDisplayEnabled;

    const isInitialized = this.ensureInitialized();

    if (!this._container && isInitialized) {
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
    if (this._domReadyListenerRegistered) {
      document.removeEventListener('DOMContentLoaded', this._domReadyHandler);
      this._domReadyListenerRegistered = false;
    }
    this._dropdown = null;
    this._container = null;
    this._runs.clear();
    this._onDidChange = null;
    this._pendingActiveId = null;
    this._isDisplayEnabled = true;
    this._labelFormatter = null;
  }

  getLabelFormatter() {
    if (!this._labelFormatter) {
      this._labelFormatter = new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }

    return this._labelFormatter;
  }
}
