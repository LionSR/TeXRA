// Local imports - progress view
import {
  STREAM_STATUS,
  ALL_TOOLBAR_BUTTON_IDS,
  ELEMENT_IDS,
} from '../constants.js';
// Local imports
import { progressViewState } from '../progressViewState.js';
import { setElementsDisabled } from '@common/domUtils.js';

/**
 * Manages status display and button states.
 */
export class Status {
  constructor() {
    this.STATUS_MAP = {
      [STREAM_STATUS.RUNNING]: {
        className: 'is-running',
        label: 'Running',
        enable: [
          ELEMENT_IDS.STOP_STREAM_BTN,
          ELEMENT_IDS.RESTORE_STATE_BTN,
          ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
        ],
      },
      [STREAM_STATUS.ERROR]: {
        className: 'is-error',
        label: 'Error',
        enable: [
          ELEMENT_IDS.RUN_NEW_BTN,
          ELEMENT_IDS.RESUME_BTN,
          ELEMENT_IDS.PACK_STREAM_BTN,
          ELEMENT_IDS.CLEAN_STREAM_BTN,
          ELEMENT_IDS.RESTORE_STATE_BTN,
          ELEMENT_IDS.DIFF_STREAM_BTN,
          ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
        ],
      },
      [STREAM_STATUS.STOPPED]: {
        className: 'is-stopped',
        label: 'Stopped',
        enable: [
          ELEMENT_IDS.RUN_NEW_BTN,
          ELEMENT_IDS.RESUME_BTN,
          ELEMENT_IDS.PACK_STREAM_BTN,
          ELEMENT_IDS.CLEAN_STREAM_BTN,
          ELEMENT_IDS.RESTORE_STATE_BTN,
          ELEMENT_IDS.DIFF_STREAM_BTN,
          ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
        ],
      },
      [STREAM_STATUS.READY]: {
        className: 'is-ready',
        label: 'Ready',
        enable: [
          ELEMENT_IDS.RUN_NEW_BTN,
          ELEMENT_IDS.RESTORE_STATE_BTN,
          ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
        ],
      },
      [STREAM_STATUS.WAITING]: {
        className: 'is-waiting',
        label: 'Waiting for follow-up',
        enable: [
          ELEMENT_IDS.STOP_STREAM_BTN,
          ELEMENT_IDS.RESTORE_STATE_BTN,
          ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
        ],
      },
      [STREAM_STATUS.RESUMING]: {
        className: 'is-resuming',
        label: 'Resuming',
        enable: [
          ELEMENT_IDS.STOP_STREAM_BTN,
          ELEMENT_IDS.RESTORE_STATE_BTN,
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
    const storageButton = document.getElementById(
      ELEMENT_IDS.OPEN_TASK_STORAGE_BTN,
    );
    const resumeButton = document.getElementById(ELEMENT_IDS.RESUME_BTN);

    const isAvailable = this._executionAvailable;

    if (resumeButton) {
      resumeButton.classList.toggle('toolbar-button--hidden', !isAvailable);
      resumeButton.setAttribute('aria-hidden', isAvailable ? 'false' : 'true');
      if (!isAvailable) {
        setElementsDisabled([resumeButton], true);
      }
    }

    if (!storageButton) {
      return;
    }

    storageButton.classList.toggle('toolbar-button--hidden', !isAvailable);
    storageButton.setAttribute('aria-hidden', isAvailable ? 'false' : 'true');
    if (!isAvailable) {
      setElementsDisabled([storageButton], true);
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
          if (el.id === ELEMENT_IDS.RESUME_BTN && !this._executionAvailable) {
            return false;
          }
          return true;
        });
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
