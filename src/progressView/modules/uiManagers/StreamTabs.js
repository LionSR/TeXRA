// Local imports
import { ELEMENT_IDS, STREAM_STATUS } from '../constants.js';
import { createFromTemplate } from '@common/templateUtils.js';
import { formatRelativeTime } from '@common/stringUtils.js';
import {
  AGENT_DECORATORS,
  getAgentTypeDecorator,
  applyCodiconClass,
} from '@common/iconConstants.js';

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
    let activeInfo = null;
    streams.forEach((info) => {
      if (!info || typeof info !== 'object') {
        console.warn('StreamTabs.update: invalid stream value:', info);
        return;
      }
      const tooltip = this._buildTooltip(info);
      const tabEl = createFromTemplate('streamTabTemplate', {
        text: {
          '.tab-title': info.label || info.name,
          '.model': info.model || '',
          '.last-active': formatRelativeTime(info.lastTimestamp),
        },
        attributes: {
          '': { title: tooltip },
          '.tab': { title: tooltip },
          '.tab-delete': { title: 'Delete stream' },
        },
        dataset: {
          '.tab': { stream: info.name },
          '.tab-delete': { stream: info.name },
        },
      });
      if (!tabEl) return;
      this._applyStatus(tabEl.querySelector('.tab-status'), info.status);
      // Apply agent decorators from shared config
      this._applyAgentDecorators(tabEl, info);
      if (info.name === activeStream) {
        tabEl.classList.add('is-active');
        activeInfo = info;
      }
      tabsContainer.appendChild(tabEl);
    });

    // Update active stream name
    const streamNameElem = document.getElementById(
      ELEMENT_IDS.ACTIVE_STREAM_NAME,
    );
    if (streamNameElem) {
      const label = activeInfo?.label || '';
      streamNameElem.textContent = label;
      streamNameElem.title = activeInfo
        ? this._buildActiveTitle(activeInfo)
        : '';
      if (activeInfo?.name) {
        streamNameElem.dataset.stream = activeInfo.name;
      } else {
        delete streamNameElem.dataset.stream;
      }
    }
  }

  _buildTooltip(info) {
    const parts = [];
    if (info?.label) {
      parts.push(info.label);
    }
    if (info?.model) {
      parts.push(`Model: ${info.model}`);
    }
    if (info?.inputFile) {
      parts.push(`Input: ${info.inputFile}`);
    }
    return parts.filter(Boolean).join(' • ');
  }

  _buildActiveTitle(info) {
    const parts = [this._buildTooltip(info)];
    if (info?.lastTimestamp) {
      const lastSeen = formatRelativeTime(info.lastTimestamp);
      if (lastSeen) {
        parts.push(`Last activity ${lastSeen}`);
      }
    }
    return parts.filter(Boolean).join('\n');
  }

  /**
   * Apply status to a status element, handling class updates and dataset.
   * @param {HTMLElement} statusEl - The status element to update
   * @param {string} status - The status value
   */
  _applyStatus(statusEl, status) {
    if (!statusEl) return;
    // Remove old status classes - ensures sync with STREAM_STATUS constants
    Object.values(STREAM_STATUS).forEach((s) =>
      statusEl.classList.remove(`is-${s}`),
    );
    // READY means execution completed - display as stopped (no active indicator)
    const normalizedStatus =
      status === STREAM_STATUS.READY
        ? STREAM_STATUS.STOPPED
        : status || STREAM_STATUS.STOPPED;
    statusEl.classList.add(`is-${normalizedStatus}`);
    statusEl.dataset.status =
      normalizedStatus.charAt(0).toUpperCase() + normalizedStatus.slice(1);
  }

  /**
   * Update status and/or timestamp for a single stream tab.
   * More efficient than full update() when only status changed.
   * @param {string} streamName - The stream to update
   * @param {string} status - New status value
   * @param {number} [lastTimestamp] - Optional timestamp for "last activity" display
   * @returns {boolean} True if any DOM element was updated, false otherwise
   */
  updateStreamStatus(streamName, status, lastTimestamp) {
    if (!streamName) {
      return false;
    }

    const tabsContainer = document.getElementById(ELEMENT_IDS.STREAM_TABS);
    if (!tabsContainer) {
      return false;
    }

    // Find the tab for this stream
    const tabEl = tabsContainer.querySelector(
      `.stream-tab .tab[data-stream="${streamName}"]`,
    );
    if (!tabEl) {
      // Tab doesn't exist yet - this is OK, status is stored in state and
      // will be applied when UPDATE_STREAMS creates the tab
      console.debug(
        `[updateStreamStatus] Tab not found for stream: ${streamName}. ` +
          'Status stored in state; will apply when tab is created.',
      );
      return false;
    }

    const streamTab = tabEl.closest('.stream-tab');
    if (!streamTab) {
      return false;
    }

    let updated = false;

    const statusEl = streamTab.querySelector('.tab-status');
    if (statusEl) {
      this._applyStatus(statusEl, status);
      updated = true;
    }

    // Update timestamp display if provided and valid (> 0 to avoid 1970 dates)
    if (lastTimestamp !== undefined && lastTimestamp > 0) {
      const lastActiveEl = streamTab.querySelector('.last-active');
      if (lastActiveEl) {
        lastActiveEl.textContent = formatRelativeTime(lastTimestamp);
        updated = true;
      }
    }

    return updated;
  }

  /**
   * Apply agent decorator icons to a tab element.
   * Uses shared AGENT_DECORATORS config for consistency.
   * @param {HTMLElement} tabEl - The tab element
   * @param {Object} info - Stream info object
   */
  _applyAgentDecorators(tabEl, info) {
    // Agent type icon (CoT, direct, toolUse)
    const agentIcon = tabEl.querySelector('.agent-type');
    if (agentIcon) {
      const key = info.agentType ?? info.agent ?? 'unknown';
      const decorator = getAgentTypeDecorator(key);
      applyCodiconClass(agentIcon, decorator.icon);
      agentIcon.title = `Agent type: ${decorator.label}`;
    }

    // Property-based decorators (remote, multipleOutputs)
    const propertyDecorators = [
      {
        selector: '.remote-agent',
        condition: info.isRemote,
        property: 'remote',
      },
      {
        selector: '.multi-file',
        condition: info.hasMultipleOutputs,
        property: 'multipleOutputs',
      },
    ];

    for (const { selector, condition, property } of propertyDecorators) {
      const iconEl = tabEl.querySelector(selector);
      if (!iconEl) continue;

      if (condition) {
        const { icon, hint } = AGENT_DECORATORS.properties[property];
        applyCodiconClass(iconEl, icon);
        iconEl.title = hint;
      } else {
        iconEl.remove();
      }
    }
  }
}
