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
    const workflowSelectorContainer = document.getElementById(
      ELEMENT_IDS.WORKFLOW_SELECTOR_CONTAINER,
    );
    const workflowSelector = document.getElementById(
      ELEMENT_IDS.WORKFLOW_SELECTOR,
    );

    tabsContainer
      .querySelectorAll('.tab-container')
      .forEach((node) => node.remove());

    const workflowEntries = [];
    const toolStreams = [];
    let activeInfo = null;
    for (const info of streams) {
      if (!info || typeof info !== 'object') {
        console.warn('StreamTabs.update: invalid stream value:', info);
        continue;
      }
      if (info.agentSessionKind === 'workflow') {
        const runs = Array.isArray(info.workflowRuns)
          ? [...info.workflowRuns]
          : [];
        workflowEntries.push({
          info,
          runs: runs.sort(
            (a, b) => (b?.startTime ?? 0) - (a?.startTime ?? 0),
          ),
          activeRunId: info.activeWorkflowRunId || null,
        });
      } else {
        toolStreams.push(info);
      }
      if (info.name === activeStream) {
        activeInfo = info;
      }
    }

    const shouldShowWorkflowSelector = workflowEntries.length > 0;
    if (workflowSelectorContainer && workflowSelector) {
      if (shouldShowWorkflowSelector) {
        workflowSelectorContainer.classList.add('visible');
        workflowSelector.innerHTML = '';
        const options = this._createWorkflowOptions(workflowEntries);
        options.forEach((option) => workflowSelector.appendChild(option));

        this._selectWorkflowOption(
          workflowSelector,
          activeStream,
          activeInfo?.activeWorkflowRunId ?? null,
        );

        workflowSelector.disabled = options.length === 0;
      } else {
        workflowSelectorContainer.classList.remove('visible');
        workflowSelector.innerHTML = '';
        workflowSelector.disabled = true;
      }
    }

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
      if (!tabEl) {
        return;
      }
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

    this._updateActiveRunSummary(activeInfo);
  }

  _createWorkflowOptions(entries) {
    const sorted = entries
      .slice()
      .sort((a, b) => this._compareWorkflowStreams(a.info, b.info));

    const options = [];
    sorted.forEach((entry) => {
      const { info, runs, activeRunId } = entry;
      const effectiveRuns = runs.length > 0
        ? runs
        : [this._createSyntheticRun(info)];

      effectiveRuns.forEach((run, index) => {
        const option = document.createElement('option');
        option.value = this._composeWorkflowOptionValue(
          info.name,
          run.id,
          index,
        );
        option.dataset.stream = info.name;
        option.dataset.runId = run.id || '';
        option.textContent = this._buildWorkflowOptionLabel(info, run);
        option.title = this._buildWorkflowRunTooltip(info, run, activeRunId);
        options.push(option);
      });
    });

    return options;
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

  _composeWorkflowOptionValue(streamId, runId, index) {
    if (runId) {
      return `${streamId}::${runId}`;
    }
    return `${streamId}::idx${index}`;
  }

  _selectWorkflowOption(selectEl, streamId, runId) {
    if (!(selectEl instanceof HTMLSelectElement)) {
      return;
    }

    const options = Array.from(selectEl.options);
    let matched = false;
    let fallback = null;

    options.forEach((option) => {
      option.selected = false;
      if (option.dataset.stream === streamId) {
        if (!fallback) {
          fallback = option;
        }
        if (runId && option.dataset.runId === runId) {
          option.selected = true;
          matched = true;
        }
      }
    });

    if (!matched) {
      const target = fallback || options[0];
      if (target) {
        target.selected = true;
        matched = true;
      }
    }

    if (matched && selectEl.selectedIndex === -1) {
      const newIndex = options.findIndex((option) => option.selected);
      if (newIndex >= 0) {
        selectEl.selectedIndex = newIndex;
      }
    }
  }

  _compareWorkflowStreams(a, b) {
    const aTime = a.lastTimestamp ?? a.creationTimestamp ?? 0;
    const bTime = b.lastTimestamp ?? b.creationTimestamp ?? 0;
    return bTime - aTime;
  }

  _createSyntheticRun(info) {
    return {
      id: '',
      name: info.label || info.name,
      startTime: info.lastTimestamp ?? info.creationTimestamp,
      endTime: info.lastTimestamp,
      status: info.status,
    };
  }

  _buildWorkflowOptionLabel(info, run) {
    const baseLabel = info.label || info.name;
    const runLabel = this._normalizeRunLabel(run?.name);
    const timestamp = formatRelativeTime(
      run?.endTime ??
        run?.startTime ??
        info.lastTimestamp ??
        info.creationTimestamp,
    );
    const descriptors = [];
    if (runLabel) {
      descriptors.push(runLabel);
    }
    if (timestamp) {
      descriptors.push(timestamp);
    }
    if (descriptors.length === 0) {
      return baseLabel;
    }
    return `${baseLabel} • ${descriptors.join(' • ')}`;
  }

  _buildWorkflowRunTooltip(info, run, activeRunId) {
    const tooltipParts = [this._buildTooltip(info)];
    const runLabel = this._normalizeRunLabel(run?.name);
    if (runLabel) {
      tooltipParts.push(`Run: ${runLabel}`);
    }
    if (run?.status) {
      tooltipParts.push(`Status: ${run.status}`);
    }
    if (run?.startTime) {
      const startText = new Date(run.startTime).toLocaleString();
      tooltipParts.push(`Started: ${startText}`);
    }
    if (run?.endTime) {
      const endText = new Date(run.endTime).toLocaleString();
      tooltipParts.push(`Finished: ${endText}`);
    }
    if (run?.id && run.id === activeRunId) {
      tooltipParts.push('Currently active');
    }
    return tooltipParts.filter(Boolean).join('\n');
  }

  _normalizeRunLabel(label) {
    if (!label) {
      return '';
    }
    return label.replace(/^Run:\s*/i, '').trim();
  }

  _updateActiveRunSummary(activeInfo) {
    const summary = document.getElementById(ELEMENT_IDS.RUN_SUMMARY);
    if (!summary) {
      return;
    }

    if (!activeInfo || activeInfo.agentSessionKind !== 'workflow') {
      summary.textContent = '';
      return;
    }

    const activeRun = this._findActiveRun(activeInfo);
    if (!activeRun) {
      summary.textContent = '';
      return;
    }

    const parts = [];
    const runLabel = this._normalizeRunLabel(activeRun.name);
    if (runLabel) {
      parts.push(runLabel);
    }

    if (activeRun.status) {
      parts.push(activeRun.status);
    }

    const timestamp = formatRelativeTime(
      activeRun.endTime ??
        activeRun.startTime ??
        activeInfo.lastTimestamp ??
        activeInfo.creationTimestamp,
    );
    if (timestamp) {
      parts.push(timestamp);
    }

    summary.textContent = parts.filter(Boolean).join(' • ');
  }

  _findActiveRun(info) {
    const runs = Array.isArray(info.workflowRuns) ? info.workflowRuns : [];
    if (!runs.length) {
      return null;
    }

    if (info.activeWorkflowRunId) {
      const matching = runs.find((run) => run.id === info.activeWorkflowRunId);
      if (matching) {
        return matching;
      }
    }

    return runs[0];
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
