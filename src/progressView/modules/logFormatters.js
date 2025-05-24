import { marked } from 'marked';
import { getLogGroup, setLogGroup } from './stateManager.js';
import { STATUS } from './constants.js';

// Configure marked options
marked.setOptions({
  gfm: true, // Enable GitHub Flavored Markdown
  breaks: true, // Convert line breaks to <br>
  headerIds: false, // Don't add id attributes to headers
  mangle: false, // Don't mangle email addresses
});

/**
 * Format a log entry with Markdown rendering for special content
 * @param {Object} logMessage - The log message to format
 * @returns {string} Formatted HTML for the log message
 */
export function formatLogEntry(logMessage) {
  let message = logMessage.message;

  // Show thinking content before scratchpad content
  if (message.includes('Thinking content:')) {
    // Extract the actual thinking content
    const thinkingMatch = message.match(
      /<span class="message-info">(Thinking content:.*?)<\/span>/s,
    );
    if (thinkingMatch && thinkingMatch[1]) {
      let content = thinkingMatch[1];

      // Extract content after the "Thinking content:" prefix
      const contentStartIndex = content.indexOf('Thinking content:');
      if (contentStartIndex !== -1) {
        content = content.substring(
          contentStartIndex + 'Thinking content:'.length,
        );

        return formatSpecialContent(message, content, 'Thinking content:');
      }
    }
  }

  // Check for scratchpad content
  if (message.includes('data-is-scratchpad="true"')) {
    // Extract the actual scratchpad content
    const scratchpadMatch = message.match(
      /<span class="message-info">(Scratchpad content:.*?)<\/span>/s,
    );
    if (scratchpadMatch && scratchpadMatch[1]) {
      let content = scratchpadMatch[1];

      // Extract content after the "Scratchpad content:" prefix
      const contentStartIndex = content.indexOf('Scratchpad content:');
      if (contentStartIndex !== -1) {
        content = content.substring(
          contentStartIndex + 'Scratchpad content:'.length,
        );

        return formatSpecialContent(message, content, 'Scratchpad content:');
      }
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
function formatSpecialContent(message, content, contentType) {
  try {
    // Pre-process LaTeX references to protect them from markdown parsing
    content = content.replace(/\\\\ref\{([^}]+)\}/g, '@@LATEX-REF:$1@@');

    // Process content as markdown
    let parsedMarkdown = marked.parse(content);

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
    return message.replace(
      new RegExp(`<span class="message-info">${contentType}.*?</span>`, 's'),
      `<span class="message-info">${contentType}</span>
       <div class="special-content ${cssClass}">${parsedMarkdown}</div>`,
    );
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
 * Create a group header HTML
 * @param {Object} group - Log group data
 * @returns {string} HTML for group header
 */
export function createGroupHeader(group) {
  const startDate = new Date(group.startTime);
  const formattedStartTime = formatTime(startDate);

  let durationDisplay = '';
  if (group.endTime) {
    const endDate = new Date(group.endTime);
    const durationMs = endDate - startDate;
    durationDisplay = `<span class="group-duration">${formatDuration(durationMs)}</span>`;
  }

  // Add indicator based on status
  const statusIcon = getStatusIcon(group.status);

  return `
    <summary id="group-header-${group.id}" class="log-group-header ${group.status}">
      <span class="group-status-icon">${statusIcon}</span>
      <span class="group-title">${group.name}</span>
      <span class="group-time">
        <span class="group-start-time">Started: ${formattedStartTime}</span>
        ${durationDisplay}
      </span>
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
 * Format duration in milliseconds to a readable string
 * @param {number} durationMs - Duration in milliseconds
 * @returns {string} Formatted duration string
 */
export function formatDuration(durationMs) {
  // Handle edge cases
  if (durationMs < 0) return '0s';

  // For very short durations, show milliseconds
  if (durationMs < 1000) {
    return `${durationMs}ms`;
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
