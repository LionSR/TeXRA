// Local imports - progress view
// Local imports
import { ELEMENT_IDS } from '../constants.js';
import { initializeIconButtons } from '@common/iconButtonInitializer.js';
import { createFromTemplate } from '@common/templateUtils.js';
import { formatRelativeTime } from '@common/stringUtils.js';

const AGENT_ICONS = {
  CoT: 'terminal',
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
    tabsContainer.innerHTML = '';
    let activeInfo = null;
    const workflowStreams = [];
    const toolStreams = [];

    streams.forEach((info) => {
      if (!info || typeof info !== 'object') {
        console.warn('StreamTabs.update: invalid stream value:', info);
        return;
      }
      if (info.agentSessionKind === 'workflow') {
        workflowStreams.push(info);
      } else {
        toolStreams.push(info);
      }
      if (info.name === activeStream) {
        activeInfo = info;
      }
    });

    toolStreams.forEach((info) => {
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
      initializeIconButtons(tabEl);
      const statusEl = tabEl.querySelector('.tab-status');
      if (statusEl) {
        const status = info.status || 'stopped';
        statusEl.classList.add(status);
        statusEl.dataset.status =
          status.charAt(0).toUpperCase() + status.slice(1);
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
        tabEl.classList.add('active');
      }
      tabsContainer.appendChild(tabEl);
    });

    const selectorContainer = document.getElementById(
      ELEMENT_IDS.WORKFLOW_SELECTOR,
    );
    const selector = document.getElementById(
      ELEMENT_IDS.WORKFLOW_STREAM_SELECT,
    );
    if (selectorContainer && selector instanceof HTMLSelectElement) {
      if (workflowStreams.length > 0) {
        const sorted = [...workflowStreams].sort((a, b) => {
          const aTime = a.lastTimestamp ?? a.creationTimestamp ?? 0;
          const bTime = b.lastTimestamp ?? b.creationTimestamp ?? 0;
          return bTime - aTime;
        });
        const previousValue = selector.value;
        selector.innerHTML = '';
        sorted.forEach((info) => {
          const option = document.createElement('option');
          option.value = info.name;
          option.textContent = info.label || info.name;
          option.dataset.status = info.status || 'stopped';
          selector.appendChild(option);
        });
        const workflowIds = new Set(sorted.map((info) => info.name));
        if (workflowIds.has(activeStream)) {
          selector.value = activeStream;
        } else if (previousValue && workflowIds.has(previousValue)) {
          selector.value = previousValue;
        } else if (selector.options.length > 0) {
          selector.selectedIndex = 0;
        }
        selectorContainer.classList.remove('is-hidden');
        selector.dataset.selected = selector.value;
        selector.disabled = selector.options.length === 0;
      } else {
        selector.innerHTML = '';
        selector.value = '';
        selector.dataset.selected = '';
        selectorContainer.classList.add('is-hidden');
      }
    }

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
