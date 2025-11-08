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
    this._onDidChange = null;
    this._changeHandler = this._handleChange.bind(this);
  }

  _getDropdown() {
    if (!this._dropdown) {
      const dropdown = safeGetElementById(ELEMENT_IDS.RUN_SELECTOR);
      if (!dropdown) {
        return null;
      }
      dropdown.addEventListener('change', this._changeHandler);
      this._dropdown = dropdown;
    }
    return this._dropdown;
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
    const dropdown = this._getDropdown();
    if (!dropdown || !group || !group.id) {
      return;
    }

    const label = this._formatRunLabel(group);

    let option = this._options.get(group.id);
    if (!option) {
      option = document.createElement('vscode-option');
      option.value = group.id;
      dropdown.appendChild(option);
      this._options.set(group.id, option);
    }

    option.textContent = label;
    this._syncVisibility();
  }

  setRuns(groups = []) {
    const dropdown = this._getDropdown();
    if (!dropdown) {
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
      return;
    }

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
      return null;
    }

    const value = dropdown.value;
    return value || null;
  }

  removeRun(groupId) {
    const dropdown = this._getDropdown();
    if (!dropdown || !groupId) {
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
    }
    this._options.clear();
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
    dropdown.hidden = !hasRuns;
    dropdown.setAttribute('aria-hidden', hasRuns ? 'false' : 'true');
  }

  cleanup() {
    if (this._dropdown) {
      this._dropdown.removeEventListener('change', this._changeHandler);
    }
    this._dropdown = null;
    this._options.clear();
    this._onDidChange = null;
  }
}
