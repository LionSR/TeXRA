// Local imports - progress view
import { STATUS, ALL_TOOLBAR_BUTTON_IDS, ELEMENT_IDS } from '../constants.js';
// Local imports
import { progressViewState } from '../progressViewState.js';
import { setElementsDisabled } from '@common/domUtils.js';

/**
 * Manages status display and button states.
 */
export class Status {
  constructor() {
    this.STATUS_MAP = {
      [STATUS.RUNNING]: {
        className: 'running',
        label: 'Running',
        enable: [
          ELEMENT_IDS.STOP_STREAM_BTN,
          ELEMENT_IDS.RESTORE_STATE_BTN,
          ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
        ],
      },
      [STATUS.ERROR]: {
        className: 'error',
        label: 'Error',
        enable: [
          ELEMENT_IDS.RUN_AGAIN_BTN,
          ELEMENT_IDS.PACK_STREAM_BTN,
          ELEMENT_IDS.CLEAN_STREAM_BTN,
          ELEMENT_IDS.RESTORE_STATE_BTN,
          ELEMENT_IDS.DIFF_STREAM_BTN,
          ELEMENT_IDS.ERASE_STREAM_BTN,
          ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
        ],
      },
      [STATUS.STOPPED]: {
        className: 'stopped',
        label: 'Stopped',
        enable: [
          ELEMENT_IDS.RUN_AGAIN_BTN,
          ELEMENT_IDS.PACK_STREAM_BTN,
          ELEMENT_IDS.CLEAN_STREAM_BTN,
          ELEMENT_IDS.RESTORE_STATE_BTN,
          ELEMENT_IDS.DIFF_STREAM_BTN,
          ELEMENT_IDS.ERASE_STREAM_BTN,
          ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
        ],
      },
      [STATUS.READY]: {
        className: 'ready',
        label: 'Ready',
        enable: [
          ELEMENT_IDS.RESTORE_STATE_BTN,
          ELEMENT_IDS.ERASE_STREAM_BTN,
          ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
        ],
      },
      [STATUS.WAITING]: {
        className: 'waiting',
        label: 'Waiting for follow-up',
        enable: [
          ELEMENT_IDS.STOP_STREAM_BTN,
          ELEMENT_IDS.RESTORE_STATE_BTN,
          ELEMENT_IDS.ERASE_STREAM_BTN,
          ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
        ],
      },
    };

    this.BUTTON_IDS = ALL_TOOLBAR_BUTTON_IDS;
    this._buttonElements = null; // Cache for button elements
    this._executionAvailable = false;
  }

  setExecutionIdAvailability(hasExecution) {
    this._executionAvailable = Boolean(hasExecution);
    this._applyExecutionAvailability();
  }

  _applyExecutionAvailability() {
    const button = document.getElementById(ELEMENT_IDS.OPEN_TASK_STORAGE_BTN);
    if (!button) {
      return;
    }
    const isAvailable = this._executionAvailable;
    button.classList.toggle('toolbar-button--hidden', !isAvailable);
    button.setAttribute('aria-hidden', isAvailable ? 'false' : 'true');
    if (!isAvailable) {
      setElementsDisabled([button], true);
    }
  }

  /**
   * Updates the stream status indicator and enables/disables buttons accordingly
   * @param {string} status - The status to set
   */
  update(status) {
    this._applyExecutionAvailability();
    const statusIndicator = document.getElementById(
      ELEMENT_IDS.STATUS_INDICATOR,
    );
    if (!statusIndicator) {
      console.error('Status.update: statusIndicator element not found');
      return;
    }

    // Query buttons fresh each time to handle toolbar re-rendering
    const buttons = this.BUTTON_IDS.map((id) =>
      document.getElementById(id),
    ).filter(Boolean);

    setElementsDisabled(buttons, true);
    // Always enable the erase button regardless of status
    const eraseButton = document.getElementById(ELEMENT_IDS.ERASE_STREAM_BTN);
    if (eraseButton) {
      setElementsDisabled([eraseButton], false);
    }

    statusIndicator.className = 'status-indicator';
    statusIndicator.dataset.status = 'Ready';

    if (status) {
      if (typeof status !== 'string') {
        console.error('Status.update: status must be a string');
        return;
      }

      statusIndicator.classList.remove(
        STATUS.RUNNING,
        STATUS.ERROR,
        STATUS.STOPPED,
        STATUS.READY,
        STATUS.WAITING,
      );

      const cfg = this.STATUS_MAP[status] || {
        className: 'stopped',
        label: status || 'Ready',
        enable: [],
      };

      statusIndicator.classList.add(cfg.className);
      statusIndicator.dataset.status = cfg.label;

      const elementsToEnable = cfg.enable
        .map((id) => document.getElementById(id))
        .filter((el) => {
          if (!el) {
            return false;
          }
          if (
            el.id === ELEMENT_IDS.OPEN_TASK_STORAGE_BTN &&
            !this._executionAvailable
          ) {
            return false;
          }
          return true;
        });
      if (elementsToEnable.length > 0) {
        setElementsDisabled(elementsToEnable, false);
      }

      const activeStream = progressViewState.activeStream;
      if (activeStream && status !== STATUS.READY) {
        progressViewState.streamStatuses.set(activeStream, status);
      }
    }
  }
}
