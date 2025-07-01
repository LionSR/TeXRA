// Local imports
import { progressViewState } from '../progressViewState.js';
import { STATUS, TOOLBAR_BUTTONS } from '../constants.js';

/**
 * Manages status display and button states.
 */
export class Status {
  constructor() {
    this.STATUS_MAP = {
      [STATUS.RUNNING]: {
        className: 'running',
        label: 'Running',
        enable: ['stopStreamBtn', 'restoreStateBtn'],
      },
      [STATUS.ERROR]: {
        className: 'error',
        label: 'Error',
        enable: [
          'runAgainBtn',
          'packStreamBtn',
          'cleanStreamBtn',
          'restoreStateBtn',
          'diffStreamBtn',
          'eraseStreamBtn',
        ],
      },
      [STATUS.STOPPED]: {
        className: 'stopped',
        label: 'Stopped',
        enable: [
          'runAgainBtn',
          'packStreamBtn',
          'cleanStreamBtn',
          'restoreStateBtn',
          'diffStreamBtn',
          'eraseStreamBtn',
        ],
      },
      [STATUS.READY]: {
        className: 'ready',
        label: 'Ready',
        enable: ['restoreStateBtn', 'eraseStreamBtn'],
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
    const statusIndicator = document.getElementById('statusIndicator');
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
    const eraseBtn = document.getElementById('eraseStreamBtn');
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

      const activeStream = progressViewState.getActiveStream();
      if (activeStream && status !== STATUS.READY) {
        progressViewState.streamStatuses.set(activeStream, status);
      }
    }
  }
}
