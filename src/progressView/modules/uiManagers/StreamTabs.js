// Local imports - progress view
// Local imports
import { ELEMENT_IDS } from '../constants.js';
import { createFromTemplate } from '@common/templateUtils.js';
import { formatRelativeTime } from '@common/stringUtils.js';

const AGENT_ICONS = {
  CoT: 'list-tree',
  direct: 'lightbulb',
  toolUse: 'tools',
  unknown: 'question',
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

    console.log('[StreamTabs] Container element:', tabsContainer.tagName);
    console.log(
      '[StreamTabs] Updating with streams:',
      streams.length,
      'active:',
      activeStream,
    );

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
        },
        dataset: {
          '': { stream: info.name },
          '.tab-delete': { stream: info.name },
        },
      });
      if (!tabEl) return;

      // Set status indicator color based on status
      const statusEl = tabEl.querySelector('.tab-status');
      if (statusEl) {
        const status = info.status || 'stopped';
        console.log(`[StreamTabs] Setting status for ${info.name}: ${status}`);
        statusEl.classList.add(status);
        statusEl.dataset.status =
          status.charAt(0).toUpperCase() + status.slice(1);
      } else {
        console.warn('[StreamTabs] Status element not found in tab');
      }
      const agentIcon = tabEl.querySelector('.agent-type');
      if (agentIcon) {
        const key = info.agentType || info.agent || 'unknown';
        const icon = AGENT_ICONS[key] || AGENT_ICONS.unknown;
        agentIcon.classList.add('codicon', `codicon-${icon}`);
        agentIcon.title = `Agent type: ${key}`;
      }
      const multiIcon = tabEl.querySelector('.multi-file');
      if (multiIcon) {
        if (info.hasMultipleOutputs) {
          multiIcon.classList.add('codicon', 'codicon-files');
          multiIcon.title = 'Multiple output files';
        } else {
          multiIcon.remove();
        }
      }
      if (info.name === activeStream) {
        tabEl.setAttribute('selected', '');
        activeInfo = info;
      }

      console.log('[StreamTabs] Created tab element:', {
        name: info.name,
        dataset: tabEl.dataset,
        hasStatusEl: !!statusEl,
        hasDeleteBtn: !!tabEl.querySelector('.tab-delete'),
      });

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
}
