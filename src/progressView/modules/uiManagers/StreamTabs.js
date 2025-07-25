// Local imports
import { ELEMENT_IDS } from '../constants.js';
import { createFromTemplate } from '@common/templateUtils.js';

const AGENT_ICONS = {
  CoT: 'terminal',
  direct: 'lightbulb',
  toolUse: 'tools',
};

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
          '.tab-title': `${info.agentName || ''}: ${info.inputFile || ''}`,
          '.model': info.model || '',
          '.last-active': this.formatRelativeTime(info.lastTimestamp),
        },
        attributes: {
          '': { title: info.name },
          '.tab-delete': { title: 'Delete stream' },
        },
        dataset: {
          '': { stream: info.name },
          '.tab-delete': { stream: info.name },
        },
      });
      if (!tabEl) return;
      const agentIcon = tabEl.querySelector('.agent-type');
      if (agentIcon && info.agentType) {
        const icon = AGENT_ICONS[info.agentType] || AGENT_ICONS.direct;
        agentIcon.className = `codicon codicon-${icon} agent-type`;
      }
      const multi = tabEl.querySelector('.multi-file');
      if (multi) {
        if (info.hasMultipleOutputs) {
          multi.className = 'codicon codicon-files multi-file';
        } else {
          multi.remove();
        }
      }
      if (info.name === activeStream) tabEl.classList.add('active');
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

  formatRelativeTime(timestamp) {
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
