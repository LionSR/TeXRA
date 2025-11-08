// Local imports - progress view
import { ELEMENT_IDS } from '../constants.js';

// Local imports - shared helpers
import { safeGetElementById } from '@common/domUtils.js';

const DATETIME_FORMAT_OPTIONS = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
};

/**
 * Manages the dropdown that selects which run is visible in the log view.
 */
export class RunSelector {
  constructor() {
    this._dropdown = null;
    this._runs = new Map();
    this._orderedIds = [];
    this._activeRunId = null;
    this._changeHandler = null;
    this._handleChange = this._onChange.bind(this);
  }

  _getDropdown() {
    if (!this._dropdown) {
      const dropdown = safeGetElementById(ELEMENT_IDS.RUN_SELECTOR);
      if (!dropdown) {
        return null;
      }
      dropdown.addEventListener('change', this._handleChange);
      this._dropdown = dropdown;
    }
    return this._dropdown;
  }

  /**
   * Register a run with the selector.
   * @param {{ id: string, startTime: number }} run
   */
  registerRun(run) {
    if (!run || !run.id) {
      return;
    }
    this._runs.set(run.id, {
      id: run.id,
      startTime: run.startTime ?? Date.now(),
    });
    this._render();
  }

  /**
   * Remove a run from the selector.
   * @param {string} runId
   */
  removeRun(runId) {
    if (!runId) {
      return;
    }
    this._runs.delete(runId);
    if (this._activeRunId === runId) {
      this._activeRunId = null;
    }
    this._render();
  }

  /**
   * Reset the selector to its initial state.
   */
  clear() {
    this._runs.clear();
    this._orderedIds = [];
    this._activeRunId = null;
    const dropdown = this._getDropdown();
    if (dropdown) {
      dropdown.innerHTML = '';
      dropdown.hidden = true;
      dropdown.value = '';
      dropdown.setAttribute('aria-hidden', 'true');
    }
  }

  /**
   * Set a callback fired when the user selects a different run.
   * @param {(runId: string | null) => void} handler
   */
  setOnRunChange(handler) {
    this._changeHandler = typeof handler === 'function' ? handler : null;
  }

  /**
   * Update the selected run.
   * @param {string | null} runId
   */
  setActiveRun(runId) {
    const dropdown = this._getDropdown();
    if (!dropdown) {
      this._activeRunId = runId ?? null;
      return;
    }

    if (runId && !this._runs.has(runId)) {
      this._activeRunId = null;
      dropdown.value = '';
      return;
    }

    this._activeRunId = runId ?? null;
    dropdown.value = this._activeRunId ?? '';
    this._syncVisibility();
  }

  /**
   * Returns the currently selected run ID.
   * @returns {string | null}
   */
  getActiveRunId() {
    return this._activeRunId;
  }

  /**
   * Returns true if the selector contains the provided run.
   * @param {string} runId
   */
  hasRun(runId) {
    return this._runs.has(runId);
  }

  /**
   * Returns the latest (most recent) run ID.
   * @returns {string | null}
   */
  getLatestRunId() {
    if (this._orderedIds.length === 0) {
      return null;
    }
    return this._orderedIds[this._orderedIds.length - 1];
  }

  getRunIds() {
    return [...this._orderedIds];
  }

  _render() {
    const dropdown = this._getDropdown();
    if (!dropdown) {
      return;
    }

    const runs = Array.from(this._runs.values()).sort(
      (a, b) => (a.startTime || 0) - (b.startTime || 0),
    );
    this._orderedIds = runs.map((run) => run.id);

    dropdown.innerHTML = '';

    runs.forEach((run, index) => {
      const option = document.createElement('vscode-option');
      option.value = run.id;
      option.textContent = this._formatLabel(index, run.startTime);
      option.dataset.startTime = String(run.startTime ?? '');
      dropdown.appendChild(option);
    });

    if (this._activeRunId && this._runs.has(this._activeRunId)) {
      dropdown.value = this._activeRunId;
    } else if (runs.length > 0) {
      const latestId = runs[runs.length - 1].id;
      this._activeRunId = latestId;
      dropdown.value = latestId;
    } else {
      this._activeRunId = null;
      dropdown.value = '';
    }

    this._syncVisibility();
  }

  _syncVisibility() {
    const dropdown = this._dropdown;
    if (!dropdown) {
      return;
    }
    const hasRuns = this._runs.size > 0;
    dropdown.hidden = !hasRuns;
    dropdown.setAttribute('aria-hidden', hasRuns ? 'false' : 'true');
  }

  _formatLabel(index, startTime) {
    const runNumber = index + 1;
    const formattedTime = this._formatTime(startTime);
    if (formattedTime) {
      return `Run ${runNumber} — ${formattedTime}`;
    }
    return `Run ${runNumber}`;
  }

  _formatTime(time) {
    if (!time) {
      return '';
    }
    try {
      const formatter = new Intl.DateTimeFormat(
        undefined,
        DATETIME_FORMAT_OPTIONS,
      );
      return formatter.format(new Date(time));
    } catch (error) {
      if (typeof time === 'number') {
        return new Date(time).toISOString();
      }
      return String(time);
    }
  }

  _onChange(event) {
    const dropdown = event?.currentTarget;
    if (!dropdown) {
      return;
    }
    const newValue = dropdown.value || null;
    this._activeRunId = newValue;
    if (this._changeHandler) {
      this._changeHandler(newValue);
    }
  }

  /** Clean up event listeners. */
  cleanup() {
    if (this._dropdown) {
      this._dropdown.removeEventListener('change', this._handleChange);
    }
    this._dropdown = null;
    this._runs.clear();
    this._orderedIds = [];
    this._activeRunId = null;
    this._changeHandler = null;
  }
}
