/**
 * Message-style formatters for user messages, errors, and progress status.
 */

import { createFromTemplate } from '@common/templateUtils.js';
import { encodeHtml } from '@common/htmlEncoding.js';
import { setElementDataset, wrapInPre } from '../htmlBuilders.js';
import { stringifyForDisplay } from '../normalizers.js';
import { formatTimestamp } from '../timestampUtils.js';
import { createBannerEntry } from '../baseLogFormatter.js';
import { EMOJI_BY_LEVEL } from '../constants.js';

/**
 * Format user message entry
 * @param {object} normalizedPayload - Normalized payload
 * @param {string} logId - Log entry ID
 * @param {string} timestamp - Timestamp
 * @returns {HTMLElement|null} User message element or null
 */
export const formatUserMessage = (normalizedPayload, logId, timestamp) => {
  const element = createFromTemplate('userMessageTemplate');
  if (!element) return null;

  const date = new Date(timestamp);
  const { timeDisplay, tooltipTimestamp } = formatTimestamp(date);

  const timestampElem = element.querySelector('.user-message-timestamp');
  if (timestampElem) {
    timestampElem.textContent = timeDisplay;
    timestampElem.title = tooltipTimestamp;
  }

  const contentElem = element.querySelector('.user-message-content');
  if (contentElem) {
    const decodedContent = normalizedPayload?.decodedText || '';
    contentElem.textContent = decodedContent;
    if (logId) contentElem.dataset.logId = logId;
  }

  return element;
};

/**
 * Format progress status entry
 * @param {object} message - The message object
 * @returns {HTMLElement} Progress status element
 */
export const formatProgressStatus = (message) => {
  const normalizedPayload = message.normalizedPayload ?? {};
  const severity = message.level || 'info';
  const date = new Date(message.timestamp ?? Date.now());
  const { fullTimestamp, timeDisplay, tooltipTimestamp } =
    formatTimestamp(date);

  const summaryText =
    (normalizedPayload.decodedText || message.text || '').trim() ||
    'Status update';
  const detailText = stringifyForDisplay(normalizedPayload.structured);
  const emoji = EMOJI_BY_LEVEL[severity] || '•';

  const container = document.createElement('div');
  setElementDataset(container, {
    logId: message.id,
    groupId: message.groupId,
    timestamp: fullTimestamp,
  });

  const summaryLine = document.createElement('div');
  summaryLine.className = 'log-line';
  summaryLine.innerHTML = `<span class="timestamp" title="${tooltipTimestamp}">${emoji} [${timeDisplay}]</span> <span class="message-${severity}">${encodeHtml(summaryText)}</span>`;
  container.appendChild(summaryLine);

  if (detailText) {
    const detailLine = document.createElement('pre');
    detailLine.className = `log-line message-${severity}`;
    detailLine.textContent = detailText;
    container.appendChild(detailLine);
  }

  return container;
};

/**
 * Format error message as a foldable banner
 * @param {object} message - The message object
 * @returns {HTMLElement|null} Error banner element or null
 */
export const formatError = (message) => {
  const normalizedPayload = message.normalizedPayload ?? {};
  const date = new Date(message.timestamp ?? Date.now());
  const { fullTimestamp, timeDisplay, tooltipTimestamp } =
    formatTimestamp(date);

  const summaryText =
    (normalizedPayload.decodedText || message.text || '').trim() ||
    'Error occurred';

  // Build error details from structured data - order defines display priority
  const structured = normalizedPayload.structured ?? {};
  const fieldConfig = [
    { key: 'message', skip: (v) => v === summaryText },
    { key: 'operation' },
    { key: 'model' },
    { key: 'provider' },
    { key: 'statusCode' },
    { key: 'retryable' },
    { key: 'rawMessage' },
    { key: 'requestId' },
  ];

  const detailLines = fieldConfig
    .filter(({ key, skip }) => {
      const value = structured[key];
      return value !== undefined && value !== null && (!skip || !skip(value));
    })
    .map(({ key }) => `${key}: ${structured[key]}`);

  const detailText = detailLines.join('\n');

  const bannerEntry = createBannerEntry({
    logId: message.id,
    groupId: message.groupId,
    timestamp: fullTimestamp,
    iconClass: 'codicon-error',
    labelText: `[${timeDisplay}] ${summaryText}`,
    copyTitle: 'Copy error details',
    contentClass: 'banner-content--error',
    open: false,
  });

  if (!bannerEntry || !bannerEntry.element) {
    return null;
  }

  // Add error class to the banner
  bannerEntry.element.classList.add('banner-details--error');

  // If there are no details, hide the copy button and make it non-expandable
  if (!detailText) {
    if (bannerEntry.copyButton) {
      bannerEntry.copyButton.style.display = 'none';
    }
    // Remove toggle icon for non-expandable entries
    const toggleIcon = bannerEntry.element.querySelector('.toggle-icon');
    if (toggleIcon) {
      toggleIcon.style.visibility = 'hidden';
    }
  }

  if (bannerEntry.contentElem) {
    bannerEntry.contentElem.dataset.rawContent = detailText || summaryText;
    if (detailText) {
      bannerEntry.contentElem.innerHTML = `<pre class="error-details">${encodeHtml(detailText)}</pre>`;
    }
  }

  // Add timestamp tooltip to the label
  const labelElem = bannerEntry.element.querySelector('.label');
  if (labelElem) {
    labelElem.title = tooltipTimestamp;
  }

  return bannerEntry.element;
};

/**
 * Format default log message
 * @param {object} logMessage - The log message
 * @returns {HTMLElement|null} Default log line element or null if creation fails
 */
export const formatDefaultLogMessage = (logMessage) => {
  const { id, text, level, timestamp, groupId, verbose } = logMessage;
  const emoji = EMOJI_BY_LEVEL[level] || '•';
  const date = new Date(timestamp);
  const { fullTimestamp, timeDisplay, tooltipTimestamp } =
    formatTimestamp(date);

  const prefix = `<div class="log-line" data-log-id="${id}" ${
    groupId ? `data-group-id="${groupId}"` : ''
  } data-full-timestamp="${fullTimestamp}">`;
  const levelMarkup = verbose
    ? `<span class="level-${level}">${level.toUpperCase().padEnd(8)}</span> `
    : '';

  const htmlMessage =
    prefix +
    `<span class="timestamp" title="${tooltipTimestamp}">${emoji}${
      verbose ? ` [${timeDisplay}]` : ''
    }</span> ` +
    levelMarkup +
    `<span class="message-${level}">${encodeHtml(text)}</span>` +
    `</div>`;

  // Convert HTML string to DOM element
  const wrapper = document.createElement('div');
  wrapper.innerHTML = htmlMessage;
  return wrapper.firstElementChild;
};
