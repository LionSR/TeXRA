// Local imports - progress view
import { STREAM_STATUS, ELEMENT_IDS } from '../constants.js';
import { progressViewState } from '../progressViewState.js';
// Local imports - common helpers
import { safeGetElementById, setElementsDisabled } from '@common/domUtils.js';

// Buttons that require execution availability to be enabled
const EXECUTION_DEPENDENT_BUTTONS = new Set([
  ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
  ELEMENT_IDS.RESUME_BTN,
]);

// Shared button sets to reduce duplication
const ACTIVE_STREAM_BUTTONS = [
  ELEMENT_IDS.STOP_STREAM_BTN,
  ELEMENT_IDS.RESTORE_STATE_BTN,
  ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
];

const IDLE_STREAM_BUTTONS = [
  ELEMENT_IDS.RUN_NEW_BTN,
  ELEMENT_IDS.RESUME_BTN,
  ELEMENT_IDS.PACK_STREAM_BTN,
  ELEMENT_IDS.CLEAN_STREAM_BTN,
  ELEMENT_IDS.RESTORE_STATE_BTN,
  ELEMENT_IDS.DIFF_STREAM_BTN,
  ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
];

const READY_STREAM_BUTTONS = [
  ELEMENT_IDS.RUN_NEW_BTN,
  ELEMENT_IDS.PACK_STREAM_BTN,
  ELEMENT_IDS.CLEAN_STREAM_BTN,
  ELEMENT_IDS.RESTORE_STATE_BTN,
  ELEMENT_IDS.DIFF_STREAM_BTN,
  ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
];

/**
 * Manages status display and button states.
 */
export class Status {
  constructor() {
    this.STATUS_MAP = {
      [STREAM_STATUS.RUNNING]: {
        className: 'is-running',
        label: 'Running',
        enable: ACTIVE_STREAM_BUTTONS,
      },
      [STREAM_STATUS.ERROR]: {
        className: 'is-error',
        label: 'Error',
        enable: IDLE_STREAM_BUTTONS,
      },
      [STREAM_STATUS.STOPPED]: {
        className: 'is-stopped',
        label: 'Stopped',
        enable: IDLE_STREAM_BUTTONS,
      },
      [STREAM_STATUS.READY]: {
        className: 'is-ready',
        label: 'Ready',
        enable: READY_STREAM_BUTTONS,
      },
      [STREAM_STATUS.WAITING]: {
        className: 'is-waiting',
        label: 'Waiting for follow-up',
        enable: ACTIVE_STREAM_BUTTONS,
      },
      [STREAM_STATUS.RESUMING]: {
        className: 'is-resuming',
        label: 'Resuming',
        enable: ACTIVE_STREAM_BUTTONS,
      },
    };

    this._currentButtonIds = [];
    this._buttonElements = null; // Cache for button elements
    this._executionAvailable = false;
  }

  /**
   * Sets the current toolbar button IDs to filter which buttons to query.
   * Call this after toolbar.render() to ensure status updates only query existing buttons.
   * @param {string[]} buttonIds - The button IDs currently in the toolbar
   */
  setCurrentButtonIds(buttonIds) {
    this._currentButtonIds = buttonIds || [];
  }

  setExecutionIdAvailability(hasExecution) {
    this._executionAvailable = Boolean(hasExecution);
    this._applyExecutionAvailability();
  }

  _applyExecutionAvailability() {
    const isAvailable = this._executionAvailable;
    const buttonsToUpdate = [];
    // Only check execution-dependent buttons that exist in the current toolbar
    const currentToolbarButtonIds = new Set(this._currentButtonIds);

    for (const buttonId of EXECUTION_DEPENDENT_BUTTONS) {
      // Skip buttons not in the current toolbar to avoid console warnings
      if (!currentToolbarButtonIds.has(buttonId)) continue;

      const button = safeGetElementById(buttonId);
      if (!button) continue;

      button.classList.toggle('toolbar-button--hidden', !isAvailable);
      button.setAttribute('aria-hidden', isAvailable ? 'false' : 'true');
      if (!isAvailable) {
        buttonsToUpdate.push(button);
      }
    }

    if (buttonsToUpdate.length > 0) {
      setElementsDisabled(buttonsToUpdate, true);
    }
  }

  /**
   * Updates the stream status indicator and enables/disables buttons accordingly
   * @param {string} status - The status to set
   */
  update(status) {
    this._applyExecutionAvailability();
    const statusIndicator = safeGetElementById(ELEMENT_IDS.STATUS_INDICATOR);
    if (!statusIndicator) {
      console.error('Status.update: statusIndicator element not found');
      return;
    }

    // Query buttons fresh each time to handle toolbar re-rendering
    // Only query buttons that exist in the current toolbar
    const currentToolbarButtonIds = new Set(this._currentButtonIds);
    const buttons = [...currentToolbarButtonIds]
      .map((id) => safeGetElementById(id))
      .filter(Boolean);

    setElementsDisabled(buttons, true);

    statusIndicator.className = 'status-indicator';
    statusIndicator.dataset.status = 'Ready';

    if (status) {
      if (typeof status !== 'string') {
        console.error('Status.update: status must be a string');
        return;
      }

      const cfg = this.STATUS_MAP[status] || {
        className: 'is-stopped',
        label: status || 'Ready',
        enable: [],
      };

      statusIndicator.classList.add(cfg.className);
      statusIndicator.dataset.status = cfg.label;

      // Filter to only buttons that exist in the current toolbar
      const elementsToEnable = cfg.enable
        .filter(
          (id) =>
            currentToolbarButtonIds.has(id) &&
            (this._executionAvailable || !EXECUTION_DEPENDENT_BUTTONS.has(id)),
        )
        .map((id) => safeGetElementById(id))
        .filter(Boolean);

      if (elementsToEnable.length > 0) {
        setElementsDisabled(elementsToEnable, false);
      }

      const activeStream = progressViewState.activeStream;
      if (activeStream && status !== STREAM_STATUS.READY) {
        progressViewState.streamStatuses.set(activeStream, status);
      }
    }
  }
}
