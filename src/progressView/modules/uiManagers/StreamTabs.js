// Local imports
import { ELEMENT_IDS } from '../constants.js';
import { createFromTemplate } from '@common/templateUtils.js';

/**
 * Manages stream tab UI updates.
 */
export class StreamTabs {
  /**
   * Updates UI to show stream tabs and highlight the active stream
   * @param {Array} streams - Array of stream metadata objects
   * @param {string} activeStream - Currently active stream
   */
  update(streams, activeStream) {
    if (!Array.isArray(streams)) {
      console.error('StreamTabs.update: streams must be an array');
      return;
    }
    const tabsContainer = document.getElementById(ELEMENT_IDS.STREAM_TABS);
    if (!tabsContainer) {
      console.error('StreamTabs.update: streamTabs container not found');
      return;
    }
    tabsContainer.innerHTML = '';
    streams.forEach((info) => {
      if (!info || typeof info !== 'object') {
        console.warn('StreamTabs.update: invalid stream value:', info);
        return;
      }
      const tabEl = createFromTemplate('streamTabTemplate', {
        text: {
          '.tab': info.name,
          '.model': info.model || '',
          '.last-active': this._formatRelativeTime(info.lastTimestamp),
        },
        attributes: {
          '.tab': { title: info.name },
          '.tab-delete': { title: 'Delete stream' },
        },
        dataset: {
          '.tab': { stream: info.name },
          '.tab-delete': { stream: info.name },
        },
      });
      if (!tabEl) return;
      if (info.agent) {
        const icon = info.agent.toLowerCase().includes('cot')
          ? 'terminal'
          : 'lightbulb';
        tabEl
          .querySelector('.agent-type')
          .classList.add('codicon', `codicon-${icon}`);
      }
      if (info.hasMultipleOutputs) {
        tabEl
          .querySelector('.multi-file')
          .classList.add('codicon', 'codicon-files');
      } else {
        const el = tabEl.querySelector('.multi-file');
        if (el) el.remove();
      }
      if (info.name === activeStream) tabEl.classList.add('active');
      tabEl.title = info.name;
      tabsContainer.appendChild(tabEl);
    });

    // Update active stream name
    const streamNameElem = document.getElementById(
      ELEMENT_IDS.ACTIVE_STREAM_NAME,
    );
    if (streamNameElem) {
      streamNameElem.textContent = activeStream || '';
    }
  }

  _formatRelativeTime(timestamp) {
    if (!timestamp) return '';
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes === 1) return '1 min ago';
    if (minutes < 60) return `${minutes} mins ago`;
    const hours = Math.floor(minutes / 60);
    if (hours === 1) return '1 hr ago';
    if (hours < 24) return `${hours} hrs ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return '1 day ago';
    return `${days} days ago`;
  }
}
