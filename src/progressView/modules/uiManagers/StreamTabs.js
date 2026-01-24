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
 *
 * Performance: Uses incremental DOM updates when possible to avoid
 * expensive full rebuilds. Only creates/removes tabs that changed.
 */
export class StreamTabs {
  /** Cache of current tab elements by stream name for efficient lookup */
  _tabCache = new Map();

  /**
   * Updates UI to show stream tabs and highlight the active stream.
   * Uses incremental updates when possible (same streams, just metadata changed).
   * Falls back to full rebuild when stream list changes significantly.
   *
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

    // Build set of new stream names for quick lookup
    const newStreamNames = new Set(
      streams.filter((s) => s && typeof s === 'object').map((s) => s.name),
    );

    // Check if we can do incremental update (same streams, possibly reordered)
    const existingNames = new Set(this._tabCache.keys());
    const canIncremental =
      newStreamNames.size === existingNames.size &&
      [...newStreamNames].every((name) => existingNames.has(name));

    if (canIncremental && this._tabCache.size > 0) {
      // Incremental update: update existing tabs in place
      this._incrementalUpdate(streams, activeStream, tabsContainer);
    } else {
      // Full rebuild: streams added/removed or first render
      this._fullRebuild(streams, activeStream, tabsContainer);
    }

    // Update active stream name header
    const activeInfo = streams.find((s) => s?.name === activeStream);
    this._updateActiveStreamHeader(activeInfo);
  }

  /**
   * Perform incremental update of existing tabs.
   * Updates metadata and reorders if needed without destroying DOM elements.
   */
  _incrementalUpdate(streams, activeStream, tabsContainer) {
    let activeInfo = null;

    for (let i = 0; i < streams.length; i++) {
      const info = streams[i];
      if (!info || typeof info !== 'object') continue;

      const tabEl = this._tabCache.get(info.name);
      if (!tabEl) continue;

      // Update tab content
      this._updateTabContent(tabEl, info);

      // Update active state
      const isActive = info.name === activeStream;
      tabEl.classList.toggle('is-active', isActive);
      if (isActive) activeInfo = info;

      // Reorder if needed (move to correct position)
      const currentIndex = Array.from(tabsContainer.children).indexOf(tabEl);
      if (currentIndex !== i) {
        if (i >= tabsContainer.children.length) {
          tabsContainer.appendChild(tabEl);
        } else {
          tabsContainer.insertBefore(tabEl, tabsContainer.children[i]);
        }
      }
    }
  }

  /**
   * Update tab content without recreating the element.
   */
  _updateTabContent(tabEl, info) {
    const tooltip = this._buildTooltip(info);

    // Update text content
    const titleEl = tabEl.querySelector('.tab-title');
    if (titleEl) titleEl.textContent = info.label || info.name;

    const modelEl = tabEl.querySelector('.model');
    if (modelEl) modelEl.textContent = info.model || '';

    const lastActiveEl = tabEl.querySelector('.last-active');
    if (lastActiveEl) {
      lastActiveEl.textContent = formatRelativeTime(info.lastTimestamp);
    }

    // Update tooltips
    tabEl.title = tooltip;
    const tabInner = tabEl.querySelector('.tab');
    if (tabInner) tabInner.title = tooltip;

    // Update status
    this._applyStatus(tabEl.querySelector('.tab-status'), info.status);

    // Update decorators
    this._applyAgentDecorators(tabEl, info);
  }

  /**
   * Perform full rebuild of all tabs.
   * Used when streams are added/removed or on first render.
   */
  _fullRebuild(streams, activeStream, tabsContainer) {
    tabsContainer.innerHTML = '';
    this._tabCache.clear();

    const fragment = document.createDocumentFragment();
    for (const info of streams) {
      if (!info || typeof info !== 'object') {
        console.warn('StreamTabs.update: invalid stream value:', info);
        continue;
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
      if (!tabEl) continue;

      this._applyStatus(tabEl.querySelector('.tab-status'), info.status);
      this._applyAgentDecorators(tabEl, info);

      if (info.name === activeStream) {
        tabEl.classList.add('is-active');
      }

      // Cache the tab element for future incremental updates
      this._tabCache.set(info.name, tabEl);
      fragment.appendChild(tabEl);
    }
    tabsContainer.appendChild(fragment);
  }

  /**
   * Update the active stream name header element.
   */
  _updateActiveStreamHeader(activeInfo) {
    const streamNameElem = document.getElementById(
      ELEMENT_IDS.ACTIVE_STREAM_NAME,
    );
    if (!streamNameElem) return;

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
