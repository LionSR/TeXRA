// Local imports
import { ELEMENT_IDS, STREAM_STATUS } from '../constants.js';
import { createFromTemplate } from '@common/templateUtils.js';
import { formatRelativeTime } from '@common/stringUtils.js';
import {
  AGENT_DECORATORS,
  getAgentCategoryDecorator,
  applyCodiconClass,
} from '@common/iconConstants.js';

// Pre-built status class names for efficient removal
const STATUS_CLASSES = Object.values(STREAM_STATUS).map((s) => `is-${s}`);

/**
 * Manages stream tab UI updates.
 * Uses surgical DOM updates when possible to avoid full rebuilds.
 */
export class StreamTabs {
  constructor() {
    this._lastStreamNames = [];
  }

  /**
   * Check if only metadata changed (same streams in same order).
   * @param {Array} streams
   * @returns {boolean}
   */
  _canUpdateInPlace(streams) {
    if (streams.length !== this._lastStreamNames.length) return false;
    for (let i = 0; i < streams.length; i++) {
      if (streams[i]?.name !== this._lastStreamNames[i]) return false;
    }
    return true;
  }

  /**
   * Update a single tab's metadata in place.
   * @param {HTMLElement} tabEl - The tab wrapper element
   * @param {Object} info - Stream info
   * @param {boolean} isActive - Whether this is the active stream
   */
  _updateTabInPlace(tabEl, info, isActive) {
    const tooltip = this._buildTooltip(info);
    const tab = tabEl.querySelector('.tab');

    // Update text content
    const titleEl = tabEl.querySelector('.tab-title');
    if (titleEl) titleEl.textContent = info.label || info.name;

    const modelEl = tabEl.querySelector('.model');
    if (modelEl) modelEl.textContent = info.model || '';

    const lastActiveEl = tabEl.querySelector('.last-active');
    if (lastActiveEl) lastActiveEl.textContent = formatRelativeTime(info.lastTimestamp);

    // Update tooltip
    tabEl.title = tooltip;
    if (tab) tab.title = tooltip;

    // Update status and active state
    this._applyStatus(tabEl.querySelector('.tab-status'), info.status);
    tabEl.classList.toggle('is-active', isActive);
  }

  /**
   * Updates UI to show stream tabs and highlight the active stream.
   * Uses surgical updates when stream list is unchanged (only metadata changed).
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

    let activeInfo = null;

    // Fast path: same streams in same order, update in place
    if (this._canUpdateInPlace(streams)) {
      const tabs = tabsContainer.children;
      streams.forEach((info, i) => {
        if (!info || typeof info !== 'object') return;
        const isActive = info.name === activeStream;
        this._updateTabInPlace(tabs[i], info, isActive);
        if (isActive) activeInfo = info;
      });
      this._updateStreamNameHeader(activeInfo);
      return;
    }

    // Slow path: stream list changed, full rebuild required
    tabsContainer.innerHTML = '';
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

    // Track stream names for next diff check
    this._lastStreamNames = streams.map((s) => s?.name).filter(Boolean);

    this._updateStreamNameHeader(activeInfo);
  }

  /**
   * Update the active stream name header element.
   * @param {Object|null} activeInfo
   */
  _updateStreamNameHeader(activeInfo) {
    const streamNameElem = document.getElementById(
      ELEMENT_IDS.ACTIVE_STREAM_NAME,
    );
    if (streamNameElem) {
      const label = activeInfo?.label || '';
      streamNameElem.textContent = label;
      streamNameElem.title = activeInfo
        ? this._buildTooltip(activeInfo, true)
        : '';
      if (activeInfo?.name) {
        streamNameElem.dataset.stream = activeInfo.name;
      } else {
        delete streamNameElem.dataset.stream;
      }
    }
  }

  /**
   * Build tooltip text for a stream tab
   * @param {Object} info - Stream info object
   * @param {boolean} includeLastActivity - Whether to include last activity line
   * @returns {string} Tooltip text
   */
  _buildTooltip(info, includeLastActivity = false) {
    if (!info) return '';

    const mainParts = [
      info.label,
      info.model && `Model: ${info.model}`,
      info.inputFile && `Input: ${info.inputFile}`,
    ].filter(Boolean);

    const mainLine = mainParts.join(' • ');

    // Add last activity on separate line if requested and available
    if (includeLastActivity && info.lastTimestamp) {
      const lastSeen = formatRelativeTime(info.lastTimestamp);
      if (lastSeen && mainLine) return `${mainLine}\nLast activity ${lastSeen}`;
      if (lastSeen) return `Last activity ${lastSeen}`;
    }

    return mainLine;
  }

  /**
   * Apply status to a status element, handling class updates and dataset.
   * @param {HTMLElement} statusEl - The status element to update
   * @param {string} status - The status value
   */
  _applyStatus(statusEl, status) {
    if (!statusEl) return;

    // Remove all status classes efficiently
    statusEl.classList.remove(...STATUS_CLASSES);

    // READY means execution completed - display as stopped
    const normalizedStatus =
      status && status !== STREAM_STATUS.READY ? status : STREAM_STATUS.STOPPED;
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
    // Agent category icon (workflow, toolUse)
    const agentIcon = tabEl.querySelector('.agent-category');
    if (agentIcon) {
      const decorator = getAgentCategoryDecorator(info.agentCategory);
      applyCodiconClass(agentIcon, decorator.icon);
      agentIcon.title = `Category: ${decorator.label}`;
    }

    // Property-based decorators - remove if condition false, apply icon if true
    this._applyPropertyDecorator(
      tabEl,
      '.remote-agent',
      info.isRemote,
      'remote',
    );
    this._applyPropertyDecorator(
      tabEl,
      '.multi-file',
      info.hasMultipleOutputs,
      'multipleOutputs',
    );
  }

  /**
   * Apply or remove a property-based decorator icon.
   */
  _applyPropertyDecorator(tabEl, selector, condition, property) {
    const iconEl = tabEl.querySelector(selector);
    if (!iconEl) return;

    if (!condition) return iconEl.remove();

    const { icon, hint } = AGENT_DECORATORS.properties[property];
    applyCodiconClass(iconEl, icon);
    iconEl.title = hint;
  }
}
