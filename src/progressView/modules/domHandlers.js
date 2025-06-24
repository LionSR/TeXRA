import { vscode } from '@common/webviewContext.js';
// Third-party imports
import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
// Local imports - log state
import { progressViewState } from './progressViewState.js';
import { katexMacros } from './katexMacros.js';
import { formatTokens, BULLET_MARKUP } from './logFormatters.js';
import { STATUS, COMMANDS, SPLIT_SIZES, TOOLBAR_BUTTONS } from './constants.js';
import { createIconButton } from '@common/templateUtils.js';
import {
  CHEVRON_DOWN_CLASS,
  CHEVRON_RIGHT_CLASS,
} from '@common/webviewContext.js';
import Split from 'split.js';

/**
 * Manages stream tab UI updates.
 */
class StreamTabs {
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
    const tabsContainer = document.getElementById('streamTabs');
    if (!tabsContainer) {
      console.error('StreamTabs.update: streamTabs container not found');
      return;
    }
    tabsContainer.innerHTML = streams
      .map((stream) => {
        if (!stream || typeof stream !== 'string') {
          console.warn('StreamTabs.update: invalid stream value:', stream);
          return '';
        }
        return `<div class="tab-container ${stream === activeStream ? 'active' : ''}" title="${stream}">
            <button class="tab" data-stream="${stream}" title="${stream}">${stream}</button>
            <button class="tab-delete" data-stream="${stream}" title="Delete stream">
              <i class="codicon codicon-close"></i>
            </button>
          </div>`;
      })
      .join('');

    // Update current stream name
    const streamNameElem = document.getElementById('currentStreamName');
    if (streamNameElem) {
      streamNameElem.textContent = activeStream || '';
    }
  }
}

/**
 * Manages toolbar rendering.
 */
class Toolbar {
  render() {
    const container = document.getElementById('toolbarContainer');
    if (!container) return;
    container.innerHTML = '';
    TOOLBAR_BUTTONS.forEach((def) => {
      const btn = createIconButton({
        id: def.id,
        icon: def.icon,
        title: def.title,
        className: def.className,
        disabled: def.disabled,
        dataset: { command: def.command },
      });
      container.appendChild(btn);
    });
  }
}

/**
 * Manages status display and button states.
 */
class Status {
  constructor() {
    this.STATUS_MAP = {
      [STATUS.RUNNING]: {
        className: 'running',
        label: 'Running',
        enable: ['stopStreamBtn', 'restoreStateBtn'],
      },
      [STATUS.ERROR]: {
        className: 'error',
        label: 'Error',
        enable: [
          'runAgainBtn',
          'packStreamBtn',
          'cleanStreamBtn',
          'restoreStateBtn',
          'diffStreamBtn',
          'eraseStreamBtn',
        ],
      },
      [STATUS.STOPPED]: {
        className: 'stopped',
        label: 'Stopped',
        enable: [
          'runAgainBtn',
          'packStreamBtn',
          'cleanStreamBtn',
          'restoreStateBtn',
          'diffStreamBtn',
          'eraseStreamBtn',
        ],
      },
      [STATUS.READY]: {
        className: 'ready',
        label: 'Ready',
        enable: [
          'runAgainBtn',
          'packStreamBtn',
          'cleanStreamBtn',
          'restoreStateBtn',
          'diffStreamBtn',
          'eraseStreamBtn',
        ],
      },
    };

    this.BUTTON_IDS = TOOLBAR_BUTTONS.map((b) => b.id);
    this._buttonElements = null; // Cache for button elements
  }

  /**
   * Updates the stream status indicator and enables/disables buttons accordingly
   * @param {string} status - The status to set
   */
  update(status) {
    const statusIndicator = document.getElementById('statusIndicator');
    if (!statusIndicator) {
      console.error('Status.update: statusIndicator element not found');
      return;
    }

    const buttons = this._buttonElements ||= this.BUTTON_IDS.map(id => 
      document.getElementById(id)
    ).filter(Boolean);

    buttons.forEach((b) => {
      if (b) b.disabled = true;
    });

    statusIndicator.className = 'status-indicator';
    statusIndicator.dataset.status = 'Ready';

    if (status) {
      if (typeof status !== 'string') {
        console.error('Status.update: status must be a string');
        return;
      }

      statusIndicator.classList.remove('running', 'error', 'stopped', 'ready');

      const cfg = this.STATUS_MAP[status] || {
        className: 'stopped',
        label: status || 'Ready',
        enable: [],
      };

      statusIndicator.classList.add(cfg.className);
      statusIndicator.dataset.status = cfg.label;

      cfg.enable.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = false;
      });

      const currentStream = progressViewState.getCurrentStream();
      if (currentStream && status !== STATUS.READY) {
        progressViewState.streamStatuses.set(currentStream, status);
      }
    }
  }
}

/**
 * Manages usage summary display.
 */
class UsageSummary {
  constructor() {
    this._summaryElem = null;
  }

  /**
   * Update token and cost summary in the header by aggregating usage from
   * "Round" groups. Falls back to the provided usage if given.
   * @param {Object} [usage] - Optional pre-computed usage totals
   */
  update(usage) {
    // Cache the summary element
    if (!this._summaryElem) {
      this._summaryElem = document.getElementById('runSummary');
    }
    if (!this._summaryElem) return;

    let totals = usage;

    // If usage is not provided, compute it from existing log groups
    if (!totals) {
      totals = { inputTokens: 0, outputTokens: 0, cost: 0 };
      for (const group of progressViewState.taskGroups.getAll().values()) {
        if (group.usage) {
          totals.inputTokens += group.usage.inputTokens || 0;
          totals.outputTokens += group.usage.outputTokens || 0;
          totals.cost += group.usage.cost || 0;
        }
      }
    }

    // Clear the summary - we're showing total usage in the files section now
    this._summaryElem.textContent = '';
  }

  /**
   * Compute total usage from all groups
   * @returns {Object} Total usage with inputTokens, outputTokens, and cost
   */
  computeTotal() {
    const totals = { inputTokens: 0, outputTokens: 0, cost: 0 };
    for (const group of progressViewState.taskGroups.getAll().values()) {
      if (group.usage) {
        totals.inputTokens += group.usage.inputTokens || 0;
        totals.outputTokens += group.usage.outputTokens || 0;
        totals.cost += group.usage.cost || 0;
      }
    }
    return totals;
  }
}

/**
 * Manages usage display for individual groups.
 */
class UsageGroup {
  constructor() {
    this.usageSummary = new UsageSummary();
  }

  /**
   * Update token and cost usage for a specific group
   * @param {string} groupId - ID of the group to update
   * @param {Object} usage - Usage data with inputTokens, outputTokens, cost
   * @param {boolean} skipPropagate - Whether to skip propagating to parents
   */
  update(groupId, usage, skipPropagate = false) {
    if (!groupId) {
      console.error('UsageGroup.update: groupId is required');
      return;
    }

    const groupHeader = document.getElementById(`group-header-${groupId}`);
    if (!groupHeader) {
      console.warn(`UsageGroup.update: Group header not found for ID: ${groupId}`);
      return;
    }

    // Find or create usage display element in the group header
    let usageElem = groupHeader.querySelector('.group-usage');
    if (!usageElem) {
      usageElem = document.createElement('span');
      usageElem.className = 'group-usage';

      // Determine if this is a top-level group by checking for the 'top-level' class
      const isTopLevel = groupHeader.classList.contains('top-level');
      this.insertUsageElement(groupHeader, usageElem, isTopLevel);
    }

    if (!usage) {
      usageElem.textContent = '';
      return;
    }

    const { inputTokens = 0, outputTokens = 0, cost = 0 } = usage;
    usageElem.innerHTML =
      `<i class="codicon codicon-arrow-up"></i> ${formatTokens(inputTokens)}, ` +
      `<i class="codicon codicon-arrow-down"></i> ${formatTokens(outputTokens)}, ` +
      `$${cost.toFixed(3)}`;

    // Persist usage on the group state so the summary can be computed
    const group = progressViewState.taskGroups.get(groupId);
    if (group) {
      group.usage = { inputTokens, outputTokens, cost };
      progressViewState.taskGroups.set(groupId, group);
    }
    if (!skipPropagate) {
      this.propagateUsageToParents(groupId);
    }

    // Refresh the cumulative summary displayed in the header
    this.usageSummary.update();
  }

  /**
   * Compute aggregated usage for all children of a parent group
   * @private
   */
  computeAggregatedUsage(parentId) {
    const totals = { inputTokens: 0, outputTokens: 0, cost: 0 };
    for (const group of progressViewState.taskGroups.getAll().values()) {
      if (group.parentGroupId === parentId) {
        if (group.usage) {
          totals.inputTokens += group.usage.inputTokens || 0;
          totals.outputTokens += group.usage.outputTokens || 0;
          totals.cost += group.usage.cost || 0;
        }
        const childTotals = this.computeAggregatedUsage(group.id);
        totals.inputTokens += childTotals.inputTokens;
        totals.outputTokens += childTotals.outputTokens;
        totals.cost += childTotals.cost;
      }
    }
    return totals;
  }

  /**
   * Propagate usage updates to parent groups
   * @private
   */
  propagateUsageToParents(groupId) {
    const group = progressViewState.taskGroups.get(groupId);
    if (!group) return;

    // If this group has a parent, update the parent with aggregated usage
    if (group.parentGroupId) {
      const totals = {
        ...this.computeAggregatedUsage(group.parentGroupId),
      };
      this.update(group.parentGroupId, totals, true);
      this.propagateUsageToParents(group.parentGroupId);
    } else {
      // This is a top-level group, update it with aggregated usage from its children
      const totals = {
        ...this.computeAggregatedUsage(groupId),
      };
      this.update(groupId, totals, true);
    }
  }

  /**
   * Determines where to insert a usage element based on group level and existing elements
   * @private
   * @param {HTMLElement} groupHeader - The group header element
   * @param {HTMLElement} usageElem - The usage element to insert
   * @param {boolean} isTopLevel - Whether this is a top-level group
   */
  insertUsageElement(groupHeader, usageElem, isTopLevel) {
    const timeContainer = groupHeader.querySelector('.group-time');

    let bulletElem = groupHeader.querySelector('.group-bullet');
    if (!bulletElem) {
      const tmpl = document.createElement('template');
      tmpl.innerHTML = BULLET_MARKUP;
      bulletElem = tmpl.content.firstElementChild;
    }

    if (timeContainer) {
      if (isTopLevel) {
        // For top-level groups: time comes first, then usage
        timeContainer.parentNode.insertBefore(
          bulletElem,
          timeContainer.nextSibling,
        );
        timeContainer.parentNode.insertBefore(
          usageElem,
          bulletElem.nextSibling,
        );
      } else {
        // For non-top-level groups: usage comes first, then time
        groupHeader.insertBefore(usageElem, timeContainer);
        groupHeader.insertBefore(bulletElem, timeContainer);
      }
    } else {
      groupHeader.appendChild(usageElem);
    }
  }
}

/**
 * Manages file list rendering.
 */
class FileList {
  /**
   * Get the effective base file for comparison operations.
   * @param {string|null|undefined} base - The explicit base file path
   * @param {string|null|undefined} original - The original source file path
   * @param {string} current - The current generated file path
   * @returns {string|null} The effective base file path or null
   */
  getEffectiveBaseFile(base, original, current) {
    // Use explicit base if available
    if (base) {
      return base;
    }

    // Use original as base if it exists and differs from current
    if (original && original !== current) {
      return original;
    }

    return null;
  }

  /**
   * Update the generated files list
   * @param {Object} filesByRound - Files organized by round
   */
  update(filesByRound) {
    const container = document.getElementById('generatedFiles');
    if (!container) return;

    container.innerHTML = '';

    const template = document.getElementById('fileItemTemplate');
    if (!template) {
      console.error('File item template not found');
      return;
    }

    if (!filesByRound || Object.keys(filesByRound).length === 0) {
      container.textContent = 'No generated files';
      return;
    }

    // Add total usage header
    const usageHeader = document.createElement('div');
    usageHeader.className = 'files-usage-header';

    // Calculate total usage from all groups
    const totals = progressViewDomHandler.usageSummary.computeTotal();

    if (totals.inputTokens || totals.outputTokens || totals.cost) {
      usageHeader.innerHTML = `
        <span class="files-usage-label">Total Usage:</span>
        <span class="files-usage-stats">
          <i class="codicon codicon-arrow-up"></i> ${formatTokens(totals.inputTokens)}, 
          <i class="codicon codicon-arrow-down"></i> ${formatTokens(totals.outputTokens)}, 
          $${totals.cost.toFixed(3)}
        </span>
      `;
      container.appendChild(usageHeader);
    }

    const rounds = Object.keys(filesByRound)
      .map((r) => parseInt(r, 10))
      .sort((a, b) => a - b);

    rounds.forEach((round) => {
      const group = document.createElement('div');
      group.className = 'round-group';

      const header = document.createElement('div');
      header.className = 'round-header';
      header.textContent = `r${round}`;
      group.appendChild(header);

      const files = filesByRound[round] || [];
      files.forEach((info) => {
        const fragment = template.content.firstElementChild.cloneNode(true);

        const dirEl = fragment.querySelector('.file-dir');
        const baseEl = fragment.querySelector('.file-basename');
        const pathSpan = fragment.querySelector('.file-path');
        const statsSpan = fragment.querySelector('.file-stats');
        const compareBtn = fragment.querySelector('.compare-btn');
        const acceptBtn = fragment.querySelector('.accept-btn');
        const mergeBtn = fragment.querySelector('.merge-btn');
        const diffBtn = fragment.querySelector('.diff-btn');
        const prevBtn = fragment.querySelector('.prev-btn');

        // Use original name if available, otherwise use generated path
        const displayPath = info.original || info.path;
        const basename = displayPath.split('/').pop();
        const dirPath = displayPath.slice(
          0,
          displayPath.length - basename.length,
        );

        if (dirEl) dirEl.textContent = dirPath;
        if (baseEl) baseEl.textContent = basename;

        if (pathSpan) {
          pathSpan.addEventListener('click', () => {
            vscode.postMessage({
              command: COMMANDS.OPEN_FILE,
              file: info.path,
            });
          });
        }

        // If file stat values (added and removed) are not present, remove the statsSpan element.
        // This ensures that the UI does not display an empty or misleading stats section.
        if (statsSpan) {
          if (info.added !== undefined && info.removed !== undefined) {
            statsSpan.innerHTML = `<span class="added">+${info.added}</span><span class="removed">-${info.removed}</span>`;
          } else if (info.added !== undefined) {
            statsSpan.innerHTML = `<span class="added">+${info.added}</span>`;
          } else {
            statsSpan.remove();
          }
        }

        this.setupFileButtons(fragment, info);

        group.appendChild(fragment);
      });

      container.appendChild(group);
    });
  }

  /**
   * Setup button event listeners for a file item
   * @private
   */
  setupFileButtons(fragment, info) {
    const compareBtn = fragment.querySelector('.compare-btn');
    const acceptBtn = fragment.querySelector('.accept-btn');
    const mergeBtn = fragment.querySelector('.merge-btn');
    const diffBtn = fragment.querySelector('.diff-btn');
    const prevBtn = fragment.querySelector('.prev-btn');

    if (compareBtn) {
      const baseFile = this.getEffectiveBaseFile(
        info.base,
        info.original,
        info.path,
      );
      if (baseFile) {
        compareBtn.addEventListener('click', () => {
          vscode.postMessage({
            command: COMMANDS.COMPARE_ORIGINAL,
            file: info.path,
            base: baseFile,
          });
        });
      } else {
        compareBtn.remove();
      }
    }

    if (acceptBtn) {
      const baseFile = this.getEffectiveBaseFile(
        info.base,
        info.original,
        info.path,
      );
      if (baseFile) {
        acceptBtn.addEventListener('click', () => {
          vscode.postMessage({
            command: COMMANDS.ACCEPT_FILE,
            file: info.path,
            base: baseFile,
          });
        });
      } else {
        acceptBtn.remove();
      }
    }

    if (mergeBtn) {
      const baseFile = this.getEffectiveBaseFile(
        info.base,
        info.original,
        info.path,
      );
      if (baseFile) {
        mergeBtn.addEventListener('click', () => {
          vscode.postMessage({
            command: COMMANDS.MERGE_FILE,
            file: info.path,
            base: baseFile,
          });
        });
      } else {
        mergeBtn.remove();
      }
    }

    if (diffBtn) {
      const baseFile = this.getEffectiveBaseFile(
        info.base,
        info.original,
        info.path,
      );
      if (baseFile) {
        diffBtn.addEventListener('click', () => {
          vscode.postMessage({
            command: COMMANDS.LATEXDIFF_FILE,
            file: info.path,
            base: baseFile,
            prev: info.prev,
          });
        });
      } else {
        diffBtn.remove();
      }
    }

    if (prevBtn) {
      if (info.prev) {
        prevBtn.addEventListener('click', () => {
          vscode.postMessage({
            command: COMMANDS.COMPARE_PREVIOUS,
            file: info.path,
            prev: info.prev,
          });
        });
      } else {
        prevBtn.remove();
      }
    }
  }
}

/**
 * Manages log entry formatting.
 */
class MessageTimestampExtractor {
  /**
   * Extract timestamp from HTML message
   * @param {string} message - HTML message containing timestamp
   * @returns {string} Extracted timestamp
   */
  extract(message) {
    // First try to extract the full timestamp from data-full-timestamp attribute
    const div = document.createElement('div');
    div.innerHTML = message;
    const logLine = div.querySelector('.log-line');
    if (logLine && logLine.dataset.fullTimestamp) {
      return logLine.dataset.fullTimestamp; // Return the full precise timestamp
    }

    // Fallback: extract from the message content using regex
    const match = message.match(/\[(.*?)\]/);
    return match ? match[1] : ''; // Extract timestamp or empty string
  }
}

class LogEntryFormatter {
  constructor() {
    this._initializeMarkdown();
  }

  _initializeMarkdown() {
    marked.setOptions({
      breaks: true,
      gfm: true,
      mangle: false,
      headerIds: false,
    });

    marked.use(
      markedKatex({
        throwOnError: false,
        errorColor: '#cc0000',
        macros: katexMacros,
      }),
    );
  }

  /**
   * Format a log entry with Markdown rendering for special content
   * @param {Object} logMessage - The log message to format
   * @returns {string} Formatted HTML for the log message
   */
  format(logMessage) {
    const message = logMessage.message;

    let type = logMessage.messageType;
    if (!type) {
      const attrMatch = message.match(/data-message-type="(.*?)"/);
      if (attrMatch) type = attrMatch[1];
    }

    if (type === 'thinking' || type === 'scratchpad') {
      const content = this._extractSpecialContent(message, type);
      if (content) {
        const label = type === 'thinking' ? 'Thinking' : 'Scratchpad';
        return this._formatSpecialContent(
          message,
          content,
          label,
          logMessage.id,
        );
      }
    }

    return message;
  }

  _extractSpecialContent(message, type) {
    const regex = new RegExp(
      `<span class="message-info"[^>]*data-message-type="${type}"[^>]*>(.*?)</span>`,
      's',
    );
    const match = message.match(regex);
    return match ? match[1] : null;
  }

  _unescapeHtml(text) {
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&');
  }

  _formatSpecialContent(message, content, contentType, logId) {
    try {
      // Unescape HTML entities that were escaped during logging
      content = this._unescapeHtml(content);

      // Pre-process LaTeX references to protect them from markdown parsing
      content = content.replace(/\\\\ref\{([^}]+)\}/g, '@@LATEX-REF:$1@@');
      content = content.replace(/\\\\cref\{([^}]+)\}/g, '@@LATEX-CREF:$1@@');
      content = content.replace(/\\\\eqref\{([^}]+)\}/g, '@@LATEX-EQREF:$1@@');

      // Process content as markdown
      let parsedMarkdown = marked.parse(content);

      // Post-process to restore and style LaTeX references
      parsedMarkdown = parsedMarkdown.replace(
        /@@LATEX-REF:([^@]+)@@/g,
        '<code class="latex-ref">\\ref{$1}</code>',
      );

      parsedMarkdown = parsedMarkdown.replace(
        /@@LATEX-CREF:([^@]+)@@/g,
        '<code class="latex-ref">\\cref{$1}</code>',
      );
      parsedMarkdown = parsedMarkdown.replace(
        /@@LATEX-EQREF:([^@]+)@@/g,
        '<code class="latex-ref">\\eqref{$1}</code>',
      );

      // Create enhanced content element with better formatting
      const idAttr = logId ? ` data-log-id="${logId}"` : '';
      // Determine label and icon based on content type
      const isThinking = contentType.includes('Thinking');
      const labelText = isThinking ? 'Thinking' : 'Scratchpad';
      const icon = isThinking ? 'codicon-lightbulb' : 'codicon-pencil';

      return `<details class="special-details" open>
        <summary>
          <i class="${CHEVRON_DOWN_CLASS} toggle-icon"></i>
          <i class="codicon ${icon}"></i>
          <span>${labelText}</span>
        </summary>
        <div class="special-content"${idAttr}>${parsedMarkdown}</div>
      </details>`;
    } catch (e) {
      console.error('Error parsing markdown:', e);
      // Fallback to original content
      return message;
    }
  }
}

/**
 * Manages task group header formatting.
 */
class TaskGroupHeaderFormatter {
  /**
   * Create a group header HTML
   * @param {Object} group - Task group data
   * @returns {string} HTML for group header
   */
  create(group) {
    const startDate = new Date(group.startTime);
    const isTopLevel = !group.parentGroupId;
    const formattedStartTime = isTopLevel
      ? this._formatDateTime(startDate)
      : this._formatTime(startDate);

    let durationDisplay = '';
    if (group.endTime) {
      const durationMs = group.endTime - group.startTime;
      durationDisplay = `<span class="group-duration">${this._formatDuration(durationMs)}</span>`;
    }

    // Add indicator based on status
    const statusIcon = this._getStatusIcon(group.status);

    // Add usage information if available
    let usageDisplay = '';
    if (group.usage) {
      const { inputTokens = 0, outputTokens = 0, cost = 0 } = group.usage;
      usageDisplay =
        `<span class="group-usage"><i class="codicon codicon-arrow-up"></i> ${formatTokens(inputTokens)}, ` +
        `<i class="codicon codicon-arrow-down"></i> ${formatTokens(outputTokens)}, ` +
        `$${cost.toFixed(3)}</span>`;
    }

    const titleMarkup = isTopLevel
      ? ''
      : `<span class="group-title">${group.name}</span>`;
    const headerClass = this._getHeaderClass(group);

    const timeMarkup = `
        <span class="group-time">
          <span class="group-start-time" data-start="${group.startTime}">
            <i class="codicon codicon-clock"></i> ${formattedStartTime}
          </span>
          ${durationDisplay}
        </span>`;

    const bulletMarkup = BULLET_MARKUP;

    const headerContents = this._formatHeaderElements(
      isTopLevel,
      timeMarkup,
      usageDisplay,
      bulletMarkup,
    );

    return `
      <summary id="group-header-${group.id}" class="${headerClass}">
        <span class="group-status-icon">${statusIcon}</span>${titleMarkup}${headerContents}
      </summary>
    `;
  }

  _getHeaderClass(group) {
    const classes = ['log-group-header', group.status];
    if (!group.parentGroupId) {
      classes.push('top-level');
    }
    return classes.join(' ');
  }

  _getStatusIcon(status) {
    switch (status) {
      case STATUS.RUNNING:
        return '<i class="codicon codicon-sync spin"></i>';
      case STATUS.ERROR:
        return '<i class="codicon codicon-error"></i>';
      case STATUS.STOPPED:
        return '<i class="codicon codicon-check"></i>';
      default:
        return '<i class="codicon codicon-circle-outline"></i>';
    }
  }

  _formatTime(date) {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  _formatDateTime(date) {
    const datePart = date.toLocaleDateString('en-CA');
    return `${datePart} ${this._formatTime(date)}`;
  }

  _formatDuration(durationMs) {
    // Handle edge cases
    if (durationMs < 0) return '0s';

    // For very short durations, show under a second
    if (durationMs < 1000) {
      return '<1s';
    }

    const seconds = Math.floor(durationMs / 1000) % 60;
    const minutes = Math.floor(durationMs / (1000 * 60));

    if (minutes === 0) {
      return `${seconds}sec`;
    } else if (seconds === 0) {
      return `${minutes}min`;
    } else {
      return `${minutes}min, ${seconds}sec`;
    }
  }

  _formatHeaderElements(isTopLevel, timeMarkup, usageDisplay, bulletMarkup) {
    if (isTopLevel) {
      // For top-level groups: time → bullet → usage
      return `${timeMarkup}${usageDisplay ? `${bulletMarkup}${usageDisplay}` : ''}`;
    } else {
      // For non-top-level groups: usage → bullet → time
      return `${usageDisplay ? `${usageDisplay}${bulletMarkup}` : ''}${timeMarkup}`;
    }
  }
}

/**
 * Manages task group DOM operations.
 */
class TaskGroupsDom {
  constructor() {
    this.headerFormatter = new TaskGroupHeaderFormatter();
    this.timestampExtractor = new MessageTimestampExtractor();
  }

  /**
   * Adds a log group to the DOM
   * @param {Object} group - Group data
   */
  add(group) {
    progressViewState.taskGroups.set(group.id, group);
    // Create the details container that will manage toggle state
    const detailsElem = document.createElement('details');
    detailsElem.className = 'log-group';
    detailsElem.id = `group-${group.id}`;

    // Create the header element as a <summary>
    const headerTemplate = document.createElement('template');
    headerTemplate.innerHTML = this.headerFormatter.create(group);
    const headerElement = headerTemplate.content.firstElementChild;

    // Create a container for the group's messages
    const groupContainer = document.createElement('div');
    groupContainer.className = 'log-group-content';
    groupContainer.id = `group-content-${group.id}`;

    // Check if we have a saved collapsed state for this group
    const isCollapsed = progressViewState.toggleStates.get(group.id);
    detailsElem.open = isCollapsed !== true;

    detailsElem.appendChild(headerElement);
    detailsElem.appendChild(groupContainer);

    // Update toggle state when the user expands/collapses the details element
    detailsElem.addEventListener('toggle', () => {
      progressViewState.toggleStates.set(group.id, !detailsElem.open);
    });

    // Determine where to add this group based on parentGroupId
    if (group.parentGroupId) {
      this.addChildGroup(detailsElem, group);
    } else {
      // This is a top-level group - add to main container
      const logContent = document.getElementById('logContent');
      logContent.appendChild(detailsElem);

      // Collapse the immediately previous top-level group now that a new one has started
      this.collapsePreviousTopLevelGroup(group.id);
    }
  }

  /**
   * Add a child group to its parent in chronological order
   * @private
   */
  addChildGroup(detailsElem, group) {
    const parentContentElement = document.getElementById(
      `group-content-${group.parentGroupId}`,
    );

    if (parentContentElement) {
      // Find the correct chronological position to insert the group
      const startTime = group.startTime;
      let insertPosition = null;

      // Get all existing child elements in the parent container
      const childElements = Array.from(parentContentElement.children);

      // Find the right position based on timestamp
      for (let i = 0; i < childElements.length; i++) {
        const child = childElements[i];

        // Check if it's a log message
        if (child.classList.contains('log-line')) {
          // Extract full timestamp from data attribute if available
          const msgFullTimestamp = child.dataset.fullTimestamp;
          let msgTime;

          if (msgFullTimestamp) {
            msgTime = new Date(msgFullTimestamp);
          } else {
            // Fallback to extracting time from content
            const msgTimestamp = this.timestampExtractor.extract(
              child.outerHTML,
            );
            // Use a dummy date for time-only comparison
            msgTime = msgTimestamp.includes('-')
              ? new Date(msgTimestamp)
              : new Date(`2000-01-01 ${msgTimestamp}`);
          }

          if (startTime < msgTime.getTime()) {
            insertPosition = child;
            break;
          }
        }
        // Check if it's another group header
        else if (child.tagName === 'DETAILS') {
          const headerEl = child.querySelector('.log-group-header');
          const timeElem = headerEl?.querySelector('.group-start-time');

          if (timeElem) {
            const otherGroupId = headerEl.id.replace('group-header-', '');
            const otherGroup = progressViewState.taskGroups.get(otherGroupId);

            if (otherGroup && otherGroup.startTime) {
              const otherTime = otherGroup.startTime;

              if (startTime < otherTime) {
                insertPosition = child;
                break;
              }
            } else {
              const otherTime = timeElem.dataset.start
                ? parseInt(timeElem.dataset.start, 10)
                : new Date(
                    `2000-01-01 ${timeElem.textContent.replace(/^[^0-9]*/, '')}`,
                  ).getTime();

              if (startTime < otherTime) {
                insertPosition = child;
                break;
              }
            }
          }
        }
      }

      // Insert at the determined position or append at the end
      if (insertPosition) {
        parentContentElement.insertBefore(detailsElem, insertPosition);
      } else {
        // Add to end of parent container
        parentContentElement.appendChild(detailsElem);
      }
    } else {
      // Fallback if parent not found - add to main container
      const logContent = document.getElementById('logContent');
      logContent.appendChild(detailsElem);
    }
  }

  /**
   * Updates the UI of a log group's header
   * @param {string} groupId - ID of the group to update
   * @param {string} status - New status
   * @param {string} endTime - End time (optional)
   */
  update(groupId, status, endTime) {
    const group = progressViewState.taskGroups.get(groupId);
    if (!group) return;

    group.status = status;
    if (endTime) {
      group.endTime = endTime;
    }

    // Update the header in the UI if it exists
    const header = document.getElementById(`group-header-${groupId}`);
    if (header) {
      header.className = this.headerFormatter._getHeaderClass(group);

      // Update the status icon
      const statusIconElem = header.querySelector('.group-status-icon');
      if (statusIconElem) {
        statusIconElem.innerHTML = this.headerFormatter._getStatusIcon(status);
      }

      // Update or add the duration display when the group finishes
      const timeContainer = header.querySelector('.group-time');

      if (endTime) {
        const endDate = endTime;
        const startDate = group.startTime;
        const durationMs = endDate - startDate;

        // Update or create duration element
        const durationElem = header.querySelector('.group-duration');
        if (durationElem) {
          durationElem.textContent = `${this.headerFormatter._formatDuration(durationMs)}`;
          durationElem.style.display = 'inline';
        } else if (timeContainer) {
          const durationSpan = document.createElement('span');
          durationSpan.className = 'group-duration';
          durationSpan.textContent = `${this.headerFormatter._formatDuration(durationMs)}`;
          durationSpan.style.display = 'inline';
          timeContainer.appendChild(durationSpan);
        }

        if (/^r\d+$/.test(group.name)) {
          this.playSystemSound();
        }
      }
    }
  }

  /**
   * Collapse a group and all of its child groups recursively
   * @private
   * @param {string} groupId - ID of the group to collapse
   */
  collapseGroupAndChildren(groupId) {
    const details = document.getElementById(`group-${groupId}`);
    if (details) {
      details.open = false;
    }
    progressViewState.toggleStates.set(groupId, true);

    for (const [childId, group] of progressViewState.taskGroups.getAll()) {
      if (group.parentGroupId === groupId) {
        this.collapseGroupAndChildren(childId);
      }
    }
  }

  /**
   * Collapse the most recent top-level group when a new one starts
   * @private
   * @param {string} currentGroupId - ID of the newly started top-level group
   */
  collapsePreviousTopLevelGroup(currentGroupId) {
    const current = progressViewState.taskGroups.get(currentGroupId);
    if (!current) return;

    let previousId = null;
    let previousStart = -Infinity;

    for (const [id, group] of progressViewState.taskGroups.getAll()) {
      if (!group.parentGroupId && id !== currentGroupId) {
        if (
          group.startTime < current.startTime &&
          group.startTime > previousStart
        ) {
          previousId = id;
          previousStart = group.startTime;
        }
      }
    }

    if (previousId) {
      this.collapseGroupAndChildren(previousId);
    }
  }

  /**
   * Play a short beep using the Web Audio API.
   * @private
   */
  playSystemSound() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 880;
      osc.connect(ctx.destination);
      osc.start();
      setTimeout(() => {
        osc.stop();
        ctx.close();
      }, 150);
    } catch (err) {
      // Ignore errors (e.g. autoplay restrictions)
    }
  }
}

/**
 * Manages individual log entry DOM operations.
 */
class LogEntriesDom {
  constructor() {
    this.entryFormatter = new LogEntryFormatter();
    this.timestampExtractor = new MessageTimestampExtractor();
  }

  /**
   * Appends a log message to its group or to the main content
   * @param {Object} logMessage - The log message to append
   * @returns {boolean} Whether the message was appended to a group
   */
  append(logMessage) {
    // If the message has a group ID, append it to the right group
    if (logMessage.groupId) {
      const groupContent = document.getElementById(
        `group-content-${logMessage.groupId}`,
      );
      if (groupContent) {
        const messageElement = document.createElement('div');
        messageElement.innerHTML = this.entryFormatter.format(logMessage);
        const logLineElement = messageElement.firstElementChild;

        // Extract timestamp from the message for chronological ordering
        const msgDate = logMessage.timestamp
          ? new Date(logMessage.timestamp)
          : null;
        const msgTimestamp =
          msgDate?.toISOString() ||
          this.timestampExtractor.extract(logMessage.message);

        // Find where to insert this message chronologically
        let insertPosition = null;

        // Get all child elements (both messages and child group containers)
        const childElements = Array.from(groupContent.children);

        // Find the right position based on timestamp
        for (let i = 0; i < childElements.length; i++) {
          const child = childElements[i];

          // If this is a nested group, get its start time
          if (child.tagName === 'DETAILS') {
            const headerEl = child.querySelector('.log-group-header');
            const startTimeElem = headerEl?.querySelector('.group-start-time');
            if (startTimeElem) {
              const groupId = headerEl.id.replace('group-header-', '');
              const group = progressViewState.taskGroups.get(groupId);
              if (group && group.startTime) {
                const childTime = group.startTime;

                if (msgDate && childTime) {
                  if (msgDate.getTime() < childTime) {
                    insertPosition = child;
                    break;
                  }
                } else {
                  const childTime = startTimeElem.dataset.start
                    ? parseInt(startTimeElem.dataset.start, 10)
                    : null;

                  if (msgDate && childTime) {
                    if (msgDate.getTime() < childTime) {
                      insertPosition = child;
                      break;
                    }
                  } else {
                    const timeText = startTimeElem.textContent.replace(
                      /^[^0-9]*/,
                      '',
                    );
                    if (msgTimestamp < timeText) {
                      insertPosition = child;
                      break;
                    }
                  }
                }
              }
            }
          }
          // If this is a log message, extract its timestamp
          else if (child.classList.contains('log-line')) {
            // Try to get the full timestamp from data attribute
            const childFullTimestamp = child.dataset.fullTimestamp;

            if (childFullTimestamp && msgTimestamp) {
              // Compare using full timestamps
              const childDate = new Date(childFullTimestamp);

              if (msgDate && childDate) {
                if (msgDate < childDate) {
                  insertPosition = child;
                  break;
                }
              } else {
                // Fallback to string comparison
                const childTimestamp = this.timestampExtractor.extract(
                  child.outerHTML,
                );
                if (msgTimestamp < childTimestamp) {
                  insertPosition = child;
                  break;
                }
              }
            } else {
              // Fallback to original behavior
              const childTimestamp = this.timestampExtractor.extract(
                child.outerHTML,
              );
              if (msgTimestamp < childTimestamp) {
                insertPosition = child;
                break;
              }
            }
          }
        }

        // Insert the message at the right position or append to the end
        if (insertPosition) {
          groupContent.insertBefore(logLineElement, insertPosition);
        } else {
          groupContent.appendChild(logLineElement);
        }
        return true;
      }
    }

    return false;
  }

  /**
   * Update an existing log entry identified by ID
   * @param {Object} logMessage - The log message with updated content
   */
  update(logMessage) {
    const existing = document.querySelector(`[data-log-id="${logMessage.id}"]`);
    if (existing) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = this.entryFormatter.format(logMessage);
      existing.replaceWith(wrapper.firstElementChild);
    }
  }
}

/**
 * Manages event handling and state application.
 */
class Events {
  /**
   * Apply saved toggle states to any groups already in the DOM
   */
  applyToggleStates() {
    const taskGroups = progressViewState.taskGroups.getAll();
    for (const [groupId, _] of taskGroups) {
      const isCollapsed = progressViewState.toggleStates.get(groupId);
      const detailsElem = document.getElementById(`group-${groupId}`);

      if (detailsElem && isCollapsed !== undefined) {
        detailsElem.open = !isCollapsed;
      }
    }
  }

  /**
   * Sets up all event listeners for the UI
   */
  setupEventListeners() {
    // Stream tab click handler
    document.getElementById('streamTabs').addEventListener('click', (e) => {
      const tabButton = e.target.closest('.tab');
      const deleteButton = e.target.closest('.tab-delete');
      if (tabButton) {
        const stream = tabButton.dataset.stream;
        vscode.postMessage({ command: COMMANDS.SWITCH_STREAM, stream });
      } else if (deleteButton) {
        const stream = deleteButton.dataset.stream;
        vscode.postMessage({ command: COMMANDS.DELETE_STREAM, stream });
      }
    });

    document
      .getElementById('toolbarContainer')
      .addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-command]');
        if (!btn) return;
        const command = btn.dataset.command;
        const currentStream = progressViewState.getCurrentStream();
        if (currentStream) {
          vscode.postMessage({ command, stream: currentStream });
        }
      });

    // Delete all button click handler
    document.getElementById('deleteAllBtn').addEventListener('click', () => {
      progressViewState.toggleStates.clearAll();
      vscode.postMessage({ command: COMMANDS.DELETE_ALL });
    });

    // Initialize split view
    Split(['.content-area', '.tabs'], {
      sizes: [SPLIT_SIZES.CONTENT, SPLIT_SIZES.TABS],
      minSize: [200, 100],
      gutterSize: 5,
      cursor: 'col-resize',
    });

    // Handle special-details toggle events
    document.addEventListener(
      'toggle',
      (e) => {
        if (e.target && e.target.classList.contains('special-details')) {
          const toggleIcon = e.target.querySelector('.toggle-icon');
          if (toggleIcon) {
            const isOpen = e.target.open;
            toggleIcon.className = `${
              isOpen ? CHEVRON_DOWN_CLASS : CHEVRON_RIGHT_CLASS
            } toggle-icon`;
          }
        }
      },
      true,
    );
  }
}

/**
 * Manages all DOM operations for the progress view.
 */
export class ProgressViewDomHandler {
  constructor() {
    // Initialize managers
    this.streamTabs = new StreamTabs();
    this.toolbar = new Toolbar();
    this.status = new Status();
    this.usageSummary = new UsageSummary();
    this.usageGroup = new UsageGroup();
    this.fileList = new FileList();
    this.taskGroups = new TaskGroupsDom();
    this.logEntries = new LogEntriesDom();
    this.events = new Events();
  }
}

// Create singleton instance
export const progressViewDomHandler = new ProgressViewDomHandler();

// Export formatter classes for reuse
export { LogEntryFormatter, MessageTimestampExtractor };
