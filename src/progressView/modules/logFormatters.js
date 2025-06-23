import MarkdownIt from 'markdown-it';
import markdownItKatex from '@vscode/markdown-it-katex';
import { getLogGroup, setLogGroup } from './stateManager.js';
import { STATUS } from './constants.js';
import { katexMacros } from './katexMacros.js';

export const BULLET_MARKUP =
  '<i class="codicon codicon-circle-small-filled group-bullet"></i>';

/**
 * Format token counts, displaying values in "k" units when exceeding 4096.
 * @param {number} tokens - Raw token count
 * @returns {string} Formatted token count
 */
export function formatTokens(tokens) {
  return tokens > 4096 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
}

// Initialize Markdown-it parser with KaTeX macros
const md = new MarkdownIt({
  breaks: true, // Convert line breaks to <br>
  linkify: true, // Automatically detect links
}).use(markdownItKatex, {
  throwOnError: false,
  errorColor: ' #cc0000',
  macros: katexMacros,
});

/**
 * Generate a sanitized CSS class string from a content type label
 * @param {string} contentType - The content type to convert
 * @returns {string} Normalized class name
 */
function generateCssClass(contentType) {
  return contentType.toLowerCase().replace(/\s+/g, '-').replace(':', '');
}

/**
 * Format a log entry with Markdown rendering for special content
 * @param {Object} logMessage - The log message to format
 * @returns {string} Formatted HTML for the log message
 */
export function formatLogEntry(logMessage) {
  let message = logMessage.message;

  // Show thinking content before scratchpad content
  if (
    logMessage.messageType === 'thinking' ||
    message.includes('Thinking content:')
  ) {
    // Extract the actual thinking content
    const thinkingMatch = message.match(
      /<span class="message-info">Thinking content:\s*(.*?)<\/span>/s,
    );
    if (thinkingMatch && thinkingMatch[1]) {
      const content = thinkingMatch[1];
      return formatSpecialContent(
        message,
        content,
        'Thinking content:',
        logMessage.id,
      );
    }
  }

  // Check for scratchpad content
  if (
    logMessage.messageType === 'scratchpad' ||
    message.includes('data-is-scratchpad="true"')
  ) {
    // Extract the actual scratchpad content
    const scratchpadMatch = message.match(
      /<span class="message-info">Scratchpad content:\s*(.*?)<\/span>/s,
    );
    if (scratchpadMatch && scratchpadMatch[1]) {
      const content = scratchpadMatch[1];
      return formatSpecialContent(
        message,
        content,
        'Scratchpad content:',
        logMessage.id,
      );
    }
  }

  return message;
}

/**
 * Format special content like scratchpad or thinking with Markdown
 * @param {string} message - The original message
 * @param {string} content - The content to format
 * @param {string} contentType - The type label (e.g., "Scratchpad content:" or "Thinking content:")
 * @returns {string} Formatted message
 */
function formatSpecialContent(message, content, contentType, logId) {
  try {
    // Unescape HTML entities that were escaped during logging
    content = content
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&');

    // Pre-process LaTeX references to protect them from markdown parsing
    content = content.replace(/\\\\ref\{([^}]+)\}/g, '@@LATEX-REF:$1@@');

    // Process content as markdown
    let parsedMarkdown = md.render(content);

    // Post-process to restore and style LaTeX references
    parsedMarkdown = parsedMarkdown.replace(
      /@@LATEX-REF:([^@]+)@@/g,
      '<code class="latex-ref">\\ref{$1}</code>',
    );

    // Fix spacing issues that might occur with consecutive paragraph elements
    parsedMarkdown = parsedMarkdown.replace(/<\/p>\s*<p>/g, '</p><p>');

    // Remove extra whitespace and newlines between HTML tags
    parsedMarkdown = parsedMarkdown.replace(/>\s+</g, '><');

    // Remove extra whitespace at start and end of content
    parsedMarkdown = parsedMarkdown.trim();

    // Create enhanced content element with better formatting
    const cssClass = contentType
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(':', '');

    // Always return just the special content box, hiding the log line wrapper entirely
    const idAttr = logId ? ` data-log-id="${logId}"` : '';
    return `<div class="special-content ${cssClass}"${idAttr}>${parsedMarkdown}</div>`;
  } catch (e) {
    console.error('Error parsing markdown:', e);
    // Fallback to original content
    return message;
  }
}

/**
 * Extract timestamp from HTML message
 * @param {string} message - HTML message containing timestamp
 * @returns {string} Extracted timestamp
 */
export function getMessageTimestamp(message) {
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

/**
 * Formats group header elements in the correct order based on group level
 * @param {boolean} isTopLevel - Whether this is a top-level group
 * @param {string} timeMarkup - The time display markup
 * @param {string} usageDisplay - The usage display markup (empty string if no usage)
 * @param {string} bulletMarkup - The bullet separator markup
 * @returns {string} Formatted header content in the correct order
 */
export function formatGroupHeaderElements(
  isTopLevel,
  timeMarkup,
  usageDisplay,
  bulletMarkup,
) {
  if (isTopLevel) {
    // For top-level groups: time → bullet → usage
    return `${timeMarkup}${usageDisplay ? `${bulletMarkup}${usageDisplay}` : ''}`;
  } else {
    // For non-top-level groups: usage → bullet → time
    return `${usageDisplay ? `${usageDisplay}${bulletMarkup}` : ''}${timeMarkup}`;
  }
}

/**
 * Get the CSS class string for a group header
 * @param {Object} group - Log group data
 * @returns {string} Computed class string
 */
export function getGroupHeaderClass(group) {
  const classes = ['log-group-header', group.status];
  if (!group.parentGroupId) {
    classes.push('top-level');
  }
  return classes.join(' ');
}

/**
 * Create a group header HTML
 * @param {Object} group - Log group data
 * @returns {string} HTML for group header
 */
export function createGroupHeader(group) {
  const startDate = new Date(group.startTime);
  const isTopLevel = !group.parentGroupId;
  const formattedStartTime = isTopLevel
    ? formatDateTime(startDate)
    : formatTime(startDate);

  let durationDisplay = '';
  if (group.endTime) {
    const durationMs = group.endTime - group.startTime;
    durationDisplay = `<span class="group-duration">${formatDuration(durationMs)}</span>`;
  }

  // Add indicator based on status
  const statusIcon = getStatusIcon(group.status);

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
  const headerClass = getGroupHeaderClass(group);

  const timeMarkup = `
      <span class="group-time">
        <span class="group-start-time" data-start="${group.startTime}">
          <i class="codicon codicon-clock"></i> ${formattedStartTime}
        </span>
        ${durationDisplay}
      </span>`;

  const bulletMarkup = BULLET_MARKUP;

  const headerContents = formatGroupHeaderElements(
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

/**
 * Get HTML for status icon based on status
 * @param {string} status - Status string
 * @returns {string} HTML for status icon
 */
export function getStatusIcon(status) {
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

/**
 * Format a date object to time string
 * @param {Date} date - Date object to format
 * @returns {string} Formatted time string
 */
export function formatTime(date) {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * Format a date object to a date and time string
 * @param {Date} date - Date object to format
 * @returns {string} Formatted date and time string
 */
export function formatDateTime(date) {
  const datePart = date.toLocaleDateString('en-CA');
  return `${datePart} ${formatTime(date)}`;
}

/**
 * Format duration in milliseconds to a readable string
 * @param {number} durationMs - Duration in milliseconds
 * @returns {string} Formatted duration string
 */
export function formatDuration(durationMs) {
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

/**
 * Update log group with new status or end time
 * @param {string} groupId - ID of the group to update
 * @param {string} status - New status
 * @param {string} endTime - End time (optional)
 */
export function updateLogGroup(groupId, status, endTime) {
  const group = getLogGroup(groupId);
  if (!group) return;

  group.status = status;
  if (endTime) {
    group.endTime = endTime;
  }

  setLogGroup(groupId, group);
}
