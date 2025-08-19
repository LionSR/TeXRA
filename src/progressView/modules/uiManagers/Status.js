// Local imports - progress view
import { STATUS, TOOLBAR_BUTTONS, ELEMENT_IDS } from '../constants.js';
// Local imports
import { progressViewState } from '../progressViewState.js';

/**
 * Manages status display and button states.
 */
export class Status {
  constructor() {
    this.STATUS_MAP = {
      [STATUS.RUNNING]: {
        className: 'running',
        label: 'Running',
        enable: [ELEMENT_IDS.STOP_STREAM_BTN, ELEMENT_IDS.RESTORE_STATE_BTN],
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
        ],
      },
      [STATUS.READY]: {
        className: 'ready',
        label: 'Ready',
        enable: [ELEMENT_IDS.RESTORE_STATE_BTN, ELEMENT_IDS.ERASE_STREAM_BTN],
      },
    };

    this.BUTTON_IDS = TOOLBAR_BUTTONS.map((b) => b.id);
    this._buttonElements = null; // Cache for button elements
  }

  /**
   * Updates the stream status indicator and enables/disables buttons accordingly
   * @param {string} status - The status to set
   */
  update(status) {
    const statusIndicator = document.getElementById(
      ELEMENT_IDS.STATUS_INDICATOR,
    );
    if (!statusIndicator) {
      console.error('Status.update: statusIndicator element not found');
      return;
    }

    const buttons = (this._buttonElements ||= this.BUTTON_IDS.map((id) =>
      document.getElementById(id),
    ).filter(Boolean));

    buttons.forEach((b) => {
      if (b) b.disabled = true;
    });

    // Always enable the erase button regardless of status
    const eraseBtn = document.getElementById(ELEMENT_IDS.ERASE_STREAM_BTN);
    if (eraseBtn) eraseBtn.disabled = false;

    statusIndicator.className = 'status-indicator';
    statusIndicator.dataset.status = 'Ready';

    if (status) {
      if (typeof status !== 'string') {
        console.error('Status.update: status must be a string');
        return;
      }

      statusIndicator.classList.remove('running', 'error', 'stopped', 'ready');

      const cfg = this.STATUS_MAP[status] || {
        className: 'stopped',
        label: status || 'Ready',
        enable: [],
      };

      statusIndicator.classList.add(cfg.className);
      statusIndicator.dataset.status = cfg.label;

      cfg.enable.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = false;
      });

      const activeStream = progressViewState.activeStream;
      if (activeStream && status !== STATUS.READY) {
        progressViewState.streamStatuses.set(activeStream, status);
      }
    }
  }
}
