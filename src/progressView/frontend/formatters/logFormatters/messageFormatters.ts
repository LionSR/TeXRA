/**
 * Message-style formatters for user messages, errors, and progress status.
 * These formatters use logMessage.text and logMessage.data directly.
 */

// Local imports - common helpers
import { createFromTemplate } from '@common/modules/templateUtils.js';

// Local imports - shared utilities
import { encodeHtml } from '@shared/utils/html';

// Local imports - formatter helpers
import { setElementDataset, wrapInPre } from '../htmlBuilders';
import { stringifyWithLanguage } from '../parseUtils';
import { formatTimestamp } from '../timestampUtils';
import { createBannerEntry } from '../baseLogFormatter';
import { EMOJI_BY_LEVEL } from '../constants';

// Local imports - shared schemas
import type { LogMessageData } from '@shared/schemas';

/** Format user message entry. */
export function formatUserMessage(
  text: string,
  logId: string,
  timestamp: number,
): HTMLElement | null {
  const element = createFromTemplate('userMessageTemplate');
  if (!element) return null;

  const { timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );

  const timestampElem = element.querySelector('.user-message-timestamp');
  if (timestampElem instanceof HTMLElement) {
    timestampElem.textContent = timeDisplay;
    timestampElem.title = tooltipTimestamp;
  }

  const contentElem = element.querySelector('.user-message-content');
  if (contentElem instanceof HTMLElement) {
    contentElem.textContent = text ?? '';
    if (logId) contentElem.dataset.logId = logId;
  }

  return element;
}

/** Format progress status entry. */
export function formatProgressStatus(message: LogMessageData): HTMLElement {
  const { level = 'info', id, groupId, timestamp, text, data } = message;
  const { fullTimestamp, timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );

  const summaryText = (text ?? '').trim() || 'Status update';
  const detailText = stringifyWithLanguage(data).text;
  const emoji = EMOJI_BY_LEVEL[level] ?? '•';

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
const ERROR_DETAIL_FIELDS: readonly string[] = [
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
] as const;

/** Format error message as a foldable banner. */
export function formatError(message: LogMessageData): HTMLElement | null {
  const { id, groupId, timestamp, text, data } = message;
  const { fullTimestamp, timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );

  const structured =
    data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const isRelayError = structured.isRelayError === true;

  // Build summary text (used for display and duplicate detection)
  const originalSummaryText = (text ?? '').trim() || 'Error occurred';
  const summaryText = isRelayError
    ? `[Relay] ${originalSummaryText}`
    : originalSummaryText;

  // Build error details from structured data
  const detailLines = ERROR_DETAIL_FIELDS.filter((key) => {
    const value = structured[key];
    // Skip null/undefined values and message if it duplicates the original summary
    return (
      value !== null &&
      value !== undefined &&
      !(key === 'message' && value === originalSummaryText)
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
    const toggleIcon = bannerEntry.element.querySelector('.toggle-icon');
    if (toggleIcon instanceof HTMLElement) {
      toggleIcon.style.setProperty('visibility', 'hidden');
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
  if (labelElem instanceof HTMLElement) {
    labelElem.title = tooltipTimestamp;
  }

  return bannerEntry.element;
}

/** Format default log message. */
export function formatDefaultLogMessage(
  logMessage: LogMessageData,
): HTMLElement | null {
  const { id, text, level, timestamp, groupId, verbose } = logMessage;
  const emoji = EMOJI_BY_LEVEL[level] ?? '•';
  const { fullTimestamp, timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );

  const groupIdAttr = groupId ? ` data-group-id="${groupId}"` : '';
  const dataAttrs = `data-log-id="${id}"${groupIdAttr}`;

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
  return wrapper.firstElementChild instanceof HTMLElement
    ? wrapper.firstElementChild
    : null;
}
