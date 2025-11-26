// Local imports - progress view
// Local imports
import { ELEMENT_IDS } from '../constants.js';
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
      const statusEl = tabEl.querySelector('.tab-status');
      if (statusEl) {
        const status = info.status || 'stopped';
        statusEl.classList.add(status);
        statusEl.dataset.status =
          status.charAt(0).toUpperCase() + status.slice(1);
      }
      // Apply agent decorators from shared config
      this._applyAgentDecorators(tabEl, info);
      if (info.name === activeStream) {
        tabEl.classList.add('active');
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
   * Apply agent decorator icons to a tab element.
   * Uses shared AGENT_DECORATORS config for consistency.
   * @param {HTMLElement} tabEl - The tab element
   * @param {Object} info - Stream info object
   */
  _applyAgentDecorators(tabEl, info) {
    // Agent type icon (CoT, direct, toolUse)
    const agentIcon = tabEl.querySelector('.agent-type');
    if (agentIcon) {
      const key = info.agentType || info.agent || 'unknown';
      const decorator = getAgentTypeDecorator(key);
      applyCodiconClass(agentIcon, decorator.icon);
      agentIcon.title = `Agent type: ${decorator.label}`;
    }

    // Remote agent icon
    const remoteIcon = tabEl.querySelector('.remote-agent');
    if (remoteIcon) {
      if (info.isRemote) {
        const { icon, hint } = AGENT_DECORATORS.properties.remote;
        applyCodiconClass(remoteIcon, icon);
        remoteIcon.title = hint;
      } else {
        remoteIcon.remove();
      }
    }

    // Multiple outputs icon
    const multiIcon = tabEl.querySelector('.multi-file');
    if (multiIcon) {
      if (info.hasMultipleOutputs) {
        const { icon, hint } = AGENT_DECORATORS.properties.multipleOutputs;
        applyCodiconClass(multiIcon, icon);
        multiIcon.title = hint;
      } else {
        multiIcon.remove();
      }
    }
  }
}
