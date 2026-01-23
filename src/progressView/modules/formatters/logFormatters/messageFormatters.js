/**
 * Message-style formatters for user messages, errors, and progress status.
 */

import { createFromTemplate } from '@common/templateUtils.js';
import { encodeHtml } from '@common/htmlEncoding.js';
import { setElementDataset, wrapInPre } from '../htmlBuilders.js';
import { stringifyWithLanguage } from '../normalizers.js';
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
export function formatUserMessage(normalizedPayload, logId, timestamp) {
  const element = createFromTemplate('userMessageTemplate');
  if (!element) return null;

  const { timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );

  const timestampElem = element.querySelector('.user-message-timestamp');
  if (timestampElem) {
    timestampElem.textContent = timeDisplay;
    timestampElem.title = tooltipTimestamp;
  }

  const contentElem = element.querySelector('.user-message-content');
  if (contentElem) {
    contentElem.textContent = normalizedPayload?.decodedText || '';
    if (logId) contentElem.dataset.logId = logId;
  }

  return element;
}

/**
 * Format progress status entry
 * @param {object} message - The message object
 * @returns {HTMLElement} Progress status element
 */
export function formatProgressStatus(message) {
  const {
    normalizedPayload = {},
    level = 'info',
    id,
    groupId,
    timestamp,
  } = message;
  const { fullTimestamp, timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp ?? Date.now()),
  );

  const summaryText =
    (normalizedPayload.decodedText || message.text || '').trim() ||
    'Status update';
  const detailText = stringifyWithLanguage(normalizedPayload.structured).text;
  const emoji = EMOJI_BY_LEVEL[level] || '•';

  const container = document.createElement('div');
  setElementDataset(container, {
    logId: id,
    groupId,
    timestamp: fullTimestamp,
  });

  const summaryLine = document.createElement('div');
  summaryLine.className = 'log-line';
  summaryLine.innerHTML =
    `<span class="timestamp" title="${tooltipTimestamp}">${emoji} [${timeDisplay}]</span> ` +
    `<span class="message-${level}">${encodeHtml(summaryText)}</span>`;
  container.appendChild(summaryLine);

  if (detailText) {
    const detailLine = document.createElement('pre');
    detailLine.className = `log-line message-${level}`;
    detailLine.textContent = detailText;
    container.appendChild(detailLine);
  }

  return container;
}

// Error detail fields in display order (matches ProviderError schema)
const ERROR_DETAIL_FIELDS = [
  'message',
  'operation',
  'model',
  'provider',
  'statusCode',
  'statusText',
  'isRelayError',
  'retryable',
  'requestId',
  'rawMessage',
  'rawErrorBody',
];

/**
 * Format error message as a foldable banner
 * @param {object} message - The message object
 * @returns {HTMLElement|null} Error banner element or null
 */
export function formatError(message) {
  const { normalizedPayload = {}, id, groupId, timestamp } = message;
  const { fullTimestamp, timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp ?? Date.now()),
  );

  const structured = normalizedPayload.structured ?? {};
  const isRelayError = structured.isRelayError === true;

  // Build summary text (used for display and duplicate detection)
  const originalSummaryText =
    (normalizedPayload.decodedText || message.text || '').trim() ||
    'Error occurred';
  const summaryText = isRelayError
    ? `[Relay] ${originalSummaryText}`
    : originalSummaryText;

  // Build error details from structured data
  const detailLines = ERROR_DETAIL_FIELDS.filter((key) => {
    const value = structured[key];
    // Skip null/undefined values and message if it duplicates the original summary
    return (
      value != null && !(key === 'message' && value === originalSummaryText)
    );
  }).map((key) => {
    const value = structured[key];
    // Format objects (like rawErrorBody) as indented JSON
    const displayValue =
      typeof value === 'object'
        ? JSON.stringify(value, null, 2)
        : String(value);
    return `${key}: ${displayValue}`;
  });

  const detailText = detailLines.join('\n');

  const bannerEntry = createBannerEntry({
    logId: id,
    groupId,
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

  // Add relay error class for distinct styling
  if (isRelayError) {
    bannerEntry.element.classList.add('banner-details--relay-error');
  }

  // If there are no details, hide the copy button and make it non-expandable
  if (!detailText) {
    bannerEntry.copyButton?.style.setProperty('display', 'none');
    bannerEntry.element
      .querySelector('.toggle-icon')
      ?.style.setProperty('visibility', 'hidden');
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
}

/**
 * Format default log message
 * @param {object} logMessage - The log message
 * @returns {HTMLElement|null} Default log line element or null if creation fails
 */
export function formatDefaultLogMessage(logMessage) {
  const { id, text, level, timestamp, groupId, verbose } = logMessage;
  const emoji = EMOJI_BY_LEVEL[level] || '•';
  const { fullTimestamp, timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );

  const dataAttrs = groupId
    ? `data-log-id="${id}" data-group-id="${groupId}"`
    : `data-log-id="${id}"`;

  const timestampContent = verbose ? `${emoji} [${timeDisplay}]` : emoji;
  const levelMarkup = verbose
    ? `<span class="level-${level}">${level.toUpperCase().padEnd(8)}</span> `
    : '';

  const htmlMessage =
    `<div class="log-line" ${dataAttrs} data-full-timestamp="${fullTimestamp}">` +
    `<span class="timestamp" title="${tooltipTimestamp}">${timestampContent}</span> ` +
    levelMarkup +
    `<span class="message-${level}">${encodeHtml(text)}</span>` +
    `</div>`;

  const wrapper = document.createElement('div');
  wrapper.innerHTML = htmlMessage;
  return wrapper.firstElementChild;
}
