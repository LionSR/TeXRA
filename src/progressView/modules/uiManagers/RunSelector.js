// Local imports - progress view
import { ELEMENT_IDS } from '../constants.js';
import { TaskGroupLevel } from '../formatters.js';
import { progressViewState } from '../progressViewState.js';

/**
 * Manages the run selector dropdown and coordinates run visibility.
 */
export class RunSelector {
  constructor() {
    this._runs = new Map();
    this._dropdown = null;
    this._container = null;
    this._instructionPanel = null;
    this._taskGroups = null;
    this._isInitialized = false;
    this._isBatching = false;
    this._autoSelect = true;
  }

  /**
   * Bind dependencies that are created in the DOM handler.
   * @param {{ taskGroups: import('../taskManagers.js').TaskGroupDomManager, instructionPanel: any }} deps
   */
  bind(deps = {}) {
    if (deps.taskGroups) {
      this._taskGroups = deps.taskGroups;
    }
    if (deps.instructionPanel) {
      this._instructionPanel = deps.instructionPanel;
    }
  }

  /**
   * Initialize DOM references and event listeners.
   */
  setup() {
    if (this._isInitialized) {
      return;
    }

    this._dropdown = document.getElementById(ELEMENT_IDS.RUN_SELECTOR);
    this._container = document.getElementById(
      ELEMENT_IDS.RUN_SELECTOR_CONTAINER,
    );
    if (!this._dropdown) {
      return;
    }

    const attachListener = () => {
      this._dropdown.addEventListener('change', (event) => {
        const target = event?.target;
        const value = target?.value ?? this._dropdown.value;
        this.select(value || null, { userInitiated: true });
      });
    };

    if (this._dropdown.updateComplete) {
      this._dropdown.updateComplete.then(attachListener);
    } else {
      attachListener();
    }

    this._isInitialized = true;
    this._renderOptions();
    this._applySelection(progressViewState.runState.getSelectedRunId());
    this._toggleVisibility();
  }

  /**
   * Begin a batch update of runs. Clears previous run metadata.
   */
  beginUpdate() {
    this._isBatching = true;
    this._runs.clear();
  }

  /**
   * Register a root run group with the selector.
   * @param {Object} group
   */
  registerRun(group) {
    if (!group || !group.id) {
      return;
    }

    const startTime = Number(group.startTime) || Date.now();
    const label = this._formatLabel(startTime);
    this._runs.set(group.id, { label, startTime });

    if (!this._isBatching) {
      this._renderOptions();
      this._ensureSelection();
    }
  }

  /**
   * Finalize the batch update and ensure selection is in sync.
   */
  finalizeUpdate() {
    this._isBatching = false;
    this._renderOptions();
    this._ensureSelection();
  }

  /**
   * Clear all runs and reset selection state.
   */
  clear() {
    this._runs.clear();
    this._autoSelect = true;
    progressViewState.runState.clear();
    if (this._isInitialized) {
      this._renderOptions();
    }
    this._applySelection(null);
    this._toggleVisibility();
  }

  /**
   * Select a run either programmatically or from user interaction.
   * @param {string|null} runId
   * @param {{ userInitiated?: boolean }} [options]
   */
  select(runId, options = {}) {
    const { userInitiated = false } = options;

    if (userInitiated) {
      this._autoSelect = false;
    }

    const hasRun = runId && this._runs.has(runId);
    const targetRunId = hasRun
      ? runId
      : this._autoSelect
        ? this._getNewestRunId()
        : progressViewState.runState.getSelectedRunId();

    this._applySelection(targetRunId || null, { force: true });
  }

  /**
   * Ensure the selection is valid after runs change.
   */
  _ensureSelection() {
    const selected = progressViewState.runState.getSelectedRunId();
    if (selected && this._runs.has(selected)) {
      this._applySelection(selected, { force: true });
      return;
    }

    if (this._runs.size === 0) {
      this._applySelection(null);
      return;
    }

    const fallback = this._getNewestRunId();
    this._applySelection(fallback, { force: true });
  }

  /**
   * Apply the provided selection to DOM and dependent managers.
   * @param {string|null} runId
   * @param {{ force?: boolean }} [options]
   */
  _applySelection(runId, options = {}) {
    const { force = false } = options;
    const normalized = runId && this._runs.has(runId) ? runId : null;
    const current = progressViewState.runState.getSelectedRunId();
    if (!force && normalized === current) {
      return;
    }

    progressViewState.runState.setSelectedRun(normalized);

    if (this._isInitialized && this._dropdown) {
      const dropdownValue = normalized ?? '';
      if (this._dropdown.value !== dropdownValue) {
        this._dropdown.value = dropdownValue;
      }
    }

    this._taskGroups?.showRun(normalized);
    this._updateInstructionPanel(normalized);
    this._toggleVisibility();
  }

  /**
   * Update the instruction panel based on the selected run.
   * @param {string|null} runId
   */
  _updateInstructionPanel(runId) {
    if (!this._instructionPanel) {
      return;
    }

    if (!runId) {
      this._instructionPanel.hide();
      return;
    }

    const data = progressViewState.runState.getInstruction(runId);
    const text = data?.text?.trim();
    if (!text || data?.sessionKind === 'toolUse') {
      this._instructionPanel.hide();
      return;
    }

    this._instructionPanel.show(text, data?.metadata ?? {});
  }

  /**
   * Update dropdown options to match the known runs.
   */
  _renderOptions() {
    if (!this._isInitialized || !this._dropdown) {
      return;
    }

    while (this._dropdown.firstChild) {
      this._dropdown.removeChild(this._dropdown.firstChild);
    }

    const sortedRuns = [...this._runs.entries()].sort(
      (a, b) => a[1].startTime - b[1].startTime,
    );

    for (const [id, data] of sortedRuns) {
      const option = document.createElement('vscode-option');
      option.value = id;
      option.textContent = data.label;
      this._dropdown.appendChild(option);
    }
  }

  /**
   * Toggle visibility of the selector container and root layout styling.
   */
  _toggleVisibility() {
    if (this._isInitialized && this._container) {
      const shouldHide = this._runs.size === 0;
      this._container.toggleAttribute('hidden', shouldHide);
    }

    const logContent = document.getElementById(ELEMENT_IDS.LOG_CONTENT);
    if (logContent) {
      logContent.classList.toggle('run-selector-active', this._runs.size > 0);
    }
  }

  /**
   * Format the dropdown label using the same timestamp style as headers.
   * @param {number} startTime
   * @returns {string}
   */
  _formatLabel(startTime) {
    try {
      return TaskGroupLevel.ROOT.formatTime(new Date(startTime));
    } catch (error) {
      return new Date(startTime).toISOString();
    }
  }

  /**
   * Get the newest run ID based on start time.
   * @returns {string|null}
   */
  _getNewestRunId() {
    let newestId = null;
    let latestTime = -Infinity;
    for (const [id, data] of this._runs.entries()) {
      if (data.startTime >= latestTime) {
        newestId = id;
        latestTime = data.startTime;
      }
    }
    return newestId;
  }
}
