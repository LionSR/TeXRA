// Local imports
import { ELEMENT_IDS } from '../constants.js';
import { createFromTemplate } from '@common/templateUtils.js';

/**
 * Manages stream tab UI updates.
 */
export class StreamTabs {
  /**
   * Updates UI to show stream tabs and highlight the active stream
   * @param {Array} streams - Array of stream names
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
    streams.forEach((stream) => {
      if (!stream || typeof stream !== 'string') {
        console.warn('StreamTabs.update: invalid stream value:', stream);
        return;
      }
      const tabEl = createFromTemplate('streamTabTemplate', {
        text: { '.tab': stream },
        attributes: {
          '.tab': { title: stream },
          '.tab-delete': { title: 'Delete stream' },
        },
        dataset: { '.tab': { stream }, '.tab-delete': { stream } },
      });
      if (!tabEl) return;
      if (stream === activeStream) tabEl.classList.add('active');
      tabEl.title = stream;
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
}
