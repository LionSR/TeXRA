// Third-party imports
import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
// Local imports
import { katexMacros } from './katexMacros.js';
import { CHEVRON_DOWN_CLASS } from '@common/webviewContext.js';
import { STATUS } from './constants.js';

// Constants
export const BULLET_MARKUP =
  '<i class="codicon codicon-circle-small-filled group-bullet"></i>';

/**
 * Represents different task group hierarchy levels with associated behaviors
 */
export const TaskGroupLevel = {
  ROOT: {
    name: 'root',
    formatTime: (date) => {
      const datePart = date.toLocaleDateString('en-CA');
      const timePart = date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
      return `${datePart} ${timePart}`;
    },
    showTitle: false,
    headerOrder: 'time-first', // time → bullet → usage
    cssClass: 'top-level',
  },
  NESTED: {
    name: 'nested',
    formatTime: (date) =>
      date.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }),
    showTitle: true,
    headerOrder: 'usage-first', // usage → bullet → time
    cssClass: null,
  },
};

/**
 * Format token counts, displaying values in "k" units when exceeding 4096.
 * @param {number} tokens - Raw token count
 * @returns {string} Formatted token count
 */
export function formatTokens(tokens) {
  return tokens > 4096 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
}

/**
 * Extracts timestamps from HTML messages.
 */
export class MessageTimestampExtractor {
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

/**
 * Handles log entry formatting with markdown support.
 */
export class LogEntryFormatter {
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

    const type = logMessage.messageType;

    if (type === 'thinking' || type === 'scratchpad') {
      const label = type === 'thinking' ? 'Thinking' : 'Scratchpad';
      return this._formatSpecialContent(message, message, label, logMessage.id);
    }

    return message;
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
 * Formats task group headers.
 */
export class TaskGroupHeaderFormatter {
  /**
   * Create a group header HTML
   * @param {Object} group - Task group data
   * @returns {string} HTML for group header
   */
  create(group) {
    const startDate = new Date(group.startTime);
    const level = this._getGroupLevel(group);
    const formattedStartTime = level.formatTime(startDate);

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

    const titleMarkup = level.showTitle
      ? `<span class="group-title">${group.name}</span>`
      : '';
    const headerClass = this._getHeaderClass(group, level);

    const timeMarkup = `
        <span class="group-time">
          <span class="group-start-time" data-start="${group.startTime}">
            <i class="codicon codicon-clock"></i> ${formattedStartTime}
          </span>
          ${durationDisplay}
        </span>`;

    const bulletMarkup = BULLET_MARKUP;

    const headerContents = this._formatHeaderElements(
      level,
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

  _getGroupLevel(group) {
    return group.parentGroupId ? TaskGroupLevel.NESTED : TaskGroupLevel.ROOT;
  }

  _getHeaderClass(group, level) {
    const classes = ['log-group-header', group.status];
    if (level.cssClass) {
      classes.push(level.cssClass);
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

  _formatHeaderElements(level, timeMarkup, usageDisplay, bulletMarkup) {
    if (level.headerOrder === 'time-first') {
      // For root level: time → bullet → usage
      return `${timeMarkup}${usageDisplay ? `${bulletMarkup}${usageDisplay}` : ''}`;
    } else {
      // For nested level: usage → bullet → time
      return `${usageDisplay ? `${usageDisplay}${bulletMarkup}` : ''}${timeMarkup}`;
    }
  }
}
