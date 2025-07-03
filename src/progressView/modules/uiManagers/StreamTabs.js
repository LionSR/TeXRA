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
      const tab = createFromTemplate(ELEMENT_IDS.STREAM_TAB_TEMPLATE, {
        text: { '.tab': stream },
        attributes: {
          '.tab': { 'data-stream': stream, title: stream },
          '.tab-delete': { 'data-stream': stream },
          '': { title: stream },
        },
      });
      if (tab) {
        if (stream === activeStream) {
          tab.classList.add('active');
        }
        tabsContainer.appendChild(tab);
      }
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
