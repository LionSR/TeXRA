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
    this._runs = new Map();
    this._onDidChange = null;
    this._changeHandler = this._handleChange.bind(this);
    this._pendingActiveId = null;

    if (document.readyState === 'loading') {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          this._initializeDropdown();
        },
        { once: true },
      );
    } else {
      this._initializeDropdown();
    }
  }

  _initializeDropdown() {
    if (this._dropdown) {
      return;
    }

    const dropdown = safeGetElementById(ELEMENT_IDS.RUN_SELECTOR);
    if (!dropdown) {
      return;
    }

    dropdown.addEventListener('change', this._changeHandler);
    this._dropdown = dropdown;
    this._renderOptions();
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

    if (this._dropdown) {
      this._renderOptions();
      this._applyActiveValue();
    }
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

    if (this._dropdown) {
      this._renderOptions();
      this._applyActiveValue();
    }
  }

  setActiveRun(groupId) {
    this._pendingActiveId = groupId || null;
    if (this._dropdown) {
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

    if (this._dropdown) {
      this._renderOptions();
      this._applyActiveValue();
    }
  }

  clear() {
    this._runs.clear();
    this._pendingActiveId = null;

    if (this._dropdown) {
      this._dropdown.innerHTML = '';
      this._dropdown.value = '';
      this._syncVisibility();
    }
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
    this._syncVisibility();
  }

  _getSortedRuns() {
    return Array.from(this._runs.values()).sort((a, b) => {
      const aTime =
        typeof a.startTime === 'number' ? a.startTime : Date.parse(a.startTime);
      const bTime =
        typeof b.startTime === 'number' ? b.startTime : Date.parse(b.startTime);
      const safeATime = Number.isNaN(aTime) ? 0 : aTime;
      const safeBTime = Number.isNaN(bTime) ? 0 : bTime;
      if (safeATime === safeBTime) {
        return a.id.localeCompare(b.id);
      }
      return safeATime - safeBTime;
    });
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
    if (!this._dropdown) {
      return;
    }

    const hasRuns = this._runs.size > 0;
    this._dropdown.disabled = !hasRuns;
    this._dropdown.hidden = !hasRuns;
    this._dropdown.setAttribute('aria-hidden', hasRuns ? 'false' : 'true');
  }

  cleanup() {
    if (this._dropdown) {
      this._dropdown.removeEventListener('change', this._changeHandler);
    }
    this._dropdown = null;
    this._runs.clear();
    this._onDidChange = null;
    this._pendingActiveId = null;
  }
}
