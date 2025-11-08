// Local imports - progress view
import { ELEMENT_IDS } from '../constants.js';
// Local imports - shared helpers
import { safeGetElementById } from '@common/domUtils.js';

const RUN_LABEL_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * Manages the run selector dropdown in the progress view header.
 */
export class RunSelector {
  constructor() {
    this._dropdown = null;
    this._options = new Map();
    this._pendingRuns = new Map();
    this._pendingActiveRunId = null;
    this._onDidChange = null;
    this._changeHandler = this._handleChange.bind(this);
    this._domReadyHandler = null;
  }

  _getDropdown() {
    if (this._dropdown) {
      const body = document.body;
      if (body && body.contains(this._dropdown)) {
        return this._dropdown;
      }
      this._dropdown = null;
    }

    const dropdown = safeGetElementById(ELEMENT_IDS.RUN_SELECTOR);
    if (dropdown) {
      dropdown.addEventListener('change', this._changeHandler);
      this._dropdown = dropdown;
      this._flushPendingRuns();
      this._applyPendingActiveRun();
      this._syncVisibility();
      return this._dropdown;
    }

    this._scheduleDomReadyCheck();
    return null;
  }

  _handleChange() {
    const dropdown = this._getDropdown();
    if (!dropdown || !this._onDidChange) {
      return;
    }

    const value = dropdown.value;
    this._onDidChange(value || null);
  }

  onDidChange(callback) {
    if (typeof callback === 'function') {
      this._onDidChange = callback;
    } else {
      this._onDidChange = null;
    }
  }

  addRun(group) {
    if (!group || !group.id) {
      return;
    }

    const dropdown = this._getDropdown();
    if (!dropdown) {
      this._pendingRuns.set(group.id, group);
      return;
    }

    this._createOrUpdateOption(group);
    this._syncVisibility();
  }

  setRuns(groups = []) {
    const dropdown = this._getDropdown();
    if (!dropdown) {
      this._options.clear();
      this._pendingRuns.clear();
      groups.forEach((group) => {
        if (group?.id) {
          this._pendingRuns.set(group.id, group);
        }
      });
      return;
    }

    dropdown.innerHTML = '';
    this._options.clear();
    groups.forEach((group) => this.addRun(group));
    this._syncVisibility();
  }

  setActiveRun(groupId) {
    const dropdown = this._getDropdown();
    if (!dropdown) {
      this._pendingActiveRunId = groupId || null;
      return;
    }

    this._pendingActiveRunId = null;

    if (groupId && this._options.has(groupId)) {
      dropdown.value = groupId;
    } else if (this._options.size > 0) {
      const firstKey = this._options.keys().next().value;
      dropdown.value = firstKey ?? '';
    } else {
      dropdown.value = '';
    }

    this._syncVisibility();
  }

  getActiveRunId() {
    const dropdown = this._getDropdown();
    if (!dropdown) {
      return this._pendingActiveRunId || null;
    }

    const value = dropdown.value;
    return value || null;
  }

  removeRun(groupId) {
    if (!groupId) {
      return;
    }

    const dropdown = this._getDropdown();
    if (!dropdown) {
      this._pendingRuns.delete(groupId);
      this._options.delete(groupId);
      if (this._pendingActiveRunId === groupId) {
        this._pendingActiveRunId = null;
      }
      return;
    }

    const option = this._options.get(groupId);
    if (option) {
      option.remove();
      this._options.delete(groupId);
    }

    this._syncVisibility();
  }

  clear() {
    const dropdown = this._getDropdown();
    if (dropdown) {
      dropdown.innerHTML = '';
      dropdown.value = '';
    } else {
      this._pendingRuns.clear();
    }
    this._options.clear();
    this._pendingActiveRunId = null;
    this._syncVisibility();
  }

  _formatRunLabel(group) {
    const name = typeof group.name === 'string' ? group.name.trim() : '';
    const timestamp = this._formatTimestamp(group.startTime);

    if (name && timestamp) {
      return `${name} • ${timestamp}`;
    }
    if (name) {
      return name;
    }
    if (timestamp) {
      return `Run • ${timestamp}`;
    }
    return 'Run';
  }

  _formatTimestamp(value) {
    if (!value) {
      return '';
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }

    return RUN_LABEL_TIME_FORMATTER.format(date);
  }

  _syncVisibility() {
    const dropdown = this._getDropdown();
    if (!dropdown) {
      return;
    }

    const hasRuns = this._options.size > 0;
    dropdown.disabled = !hasRuns;
    dropdown.toggleAttribute('hidden', !hasRuns);
    dropdown.setAttribute('aria-hidden', hasRuns ? 'false' : 'true');
  }

  cleanup() {
    if (this._dropdown) {
      this._dropdown.removeEventListener('change', this._changeHandler);
    }
    if (this._domReadyHandler) {
      document.removeEventListener('DOMContentLoaded', this._domReadyHandler);
      this._domReadyHandler = null;
    }
    this._dropdown = null;
    this._options.clear();
    this._pendingRuns.clear();
    this._pendingActiveRunId = null;
    this._onDidChange = null;
  }

  _createOrUpdateOption(group) {
    if (!group || !group.id || !this._dropdown) {
      return;
    }

    let option = this._options.get(group.id);
    if (!option) {
      option = document.createElement('vscode-option');
      option.value = group.id;
      this._dropdown.appendChild(option);
      this._options.set(group.id, option);
    }

    option.textContent = this._formatRunLabel(group);
  }

  _flushPendingRuns() {
    if (!this._dropdown || this._pendingRuns.size === 0) {
      return;
    }

    const pending = Array.from(this._pendingRuns.values());
    this._pendingRuns.clear();
    pending.forEach((group) => this._createOrUpdateOption(group));
  }

  _applyPendingActiveRun() {
    if (!this._dropdown) {
      return;
    }

    if (this._pendingActiveRunId) {
      this.setActiveRun(this._pendingActiveRunId);
    } else {
      this._syncVisibility();
    }
  }

  _scheduleDomReadyCheck() {
    if (this._domReadyHandler) {
      return;
    }

    this._domReadyHandler = () => {
      this._domReadyHandler = null;
      this._getDropdown();
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', this._domReadyHandler, {
        once: true,
      });
    } else if (typeof queueMicrotask === 'function') {
      queueMicrotask(this._domReadyHandler);
    } else {
      Promise.resolve().then(this._domReadyHandler);
    }
  }
}
