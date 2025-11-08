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
    this._container = null;
    this._runs = new Map();
    this._onDidChange = null;
    this._changeHandler = this._handleChange.bind(this);
    this._pendingActiveId = null;
    this._hideForSession = false;
    this._sessionKind = 'workflow';
    this._agentType = '';

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
      this._dropdown.removeEventListener('change', this._changeHandler);
      this._dropdown = null;
    }

    this._container = null;
    this._container = safeGetElementById(ELEMENT_IDS.RUN_SELECTOR_CONTAINER);
    const dropdown = safeGetElementById(ELEMENT_IDS.RUN_SELECTOR);
    if (!dropdown) {
      this._syncVisibility();
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
    if (this._dropdown && !this._hideForSession) {
      this._applyActiveValue();
    } else {
      this._syncVisibility();
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

  setSessionKind(sessionKind, agentType) {
    const nextKind = sessionKind || 'workflow';
    const nextAgentType = agentType || '';
    const shouldHide =
      nextKind === 'toolUse' || nextAgentType.toLowerCase() === 'direct';

    this._sessionKind = nextKind;
    this._agentType = nextAgentType;

    if (this._hideForSession !== shouldHide) {
      this._hideForSession = shouldHide;
      this._syncVisibility();
      if (shouldHide && this._dropdown) {
        this._dropdown.value = '';
      }
    } else {
      this._hideForSession = shouldHide;
      this._syncVisibility();
    }
  }

  isSelectionEnabled() {
    return !this._hideForSession;
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
      const rawATime =
        typeof a.startTime === 'number'
          ? a.startTime
          : a.startTime
            ? Date.parse(a.startTime)
            : 0;
      const rawBTime =
        typeof b.startTime === 'number'
          ? b.startTime
          : b.startTime
            ? Date.parse(b.startTime)
            : 0;
      const safeATime = Number.isNaN(rawATime) ? 0 : rawATime;
      const safeBTime = Number.isNaN(rawBTime) ? 0 : rawBTime;
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
    const name = typeof group.name === 'string' ? group.name.trim() : '';
    if (name) {
      return name;
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

    return RUN_LABEL_TIME_FORMATTER.format(date);
  }

  _syncVisibility() {
    const hasRuns = this._runs.size > 0;
    const shouldHide = !hasRuns || this._hideForSession;

    const dropdown =
      this._dropdown || safeGetElementById(ELEMENT_IDS.RUN_SELECTOR);
    if (dropdown) {
      dropdown.disabled = shouldHide;
      dropdown.hidden = shouldHide;
      dropdown.setAttribute('aria-hidden', shouldHide ? 'true' : 'false');
    }

    const container =
      this._container || safeGetElementById(ELEMENT_IDS.RUN_SELECTOR_CONTAINER);
    if (container) {
      container.toggleAttribute('hidden', shouldHide);
      container.setAttribute('aria-hidden', shouldHide ? 'true' : 'false');
    }
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
    this._hideForSession = false;
  }
}
