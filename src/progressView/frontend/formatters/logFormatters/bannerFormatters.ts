// @ts-nocheck
/**
 * Banner-style formatters for thinking, scratchpad, and model response messages.
 */

import { createBannerEntry } from '../baseLogFormatter';
import { formatTimestamp } from '../timestampUtils';
import { extractTrimmedContent } from '../normalizers';
import { processMarkdownContent } from '../markdownRenderer';

// Banner configuration by content type
const BANNER_CONFIG = {
  Thinking: {
    iconClass: 'codicon-lightbulb',
    labelText: 'Thinking',
    copyTitle: 'Copy thinking',
    contentClass: 'banner-content--thinking',
  },
  Scratchpad: {
    iconClass: 'codicon-pencil',
    labelText: 'Scratchpad',
    copyTitle: 'Copy scratchpad',
    contentClass: 'banner-content--scratchpad',
  },
};

/**
 * Format thinking or scratchpad banner content
 * @param {object} normalizedPayload - Normalized payload with decodedText
 * @param {string} contentType - 'Thinking' or 'Scratchpad'
 * @param {string} logId - Log entry ID
 * @param {string} groupId - Group ID
 * @param {string} timestamp - Timestamp
 * @returns {HTMLElement|null} Banner element or null
 */
export function formatBannerContent(
  normalizedPayload,
  contentType,
  logId,
  groupId,
  timestamp,
) {
  const { trimmed: trimmedContent, isEmpty } =
    extractTrimmedContent(normalizedPayload);
  if (isEmpty) return null;

  const config = BANNER_CONFIG[contentType] || BANNER_CONFIG.Thinking;
  const bannerEntry = createBannerEntry({
    logId,
    groupId,
    timestamp,
    ...config,
    open: false,
  });

  if (!bannerEntry?.contentElem) {
    return bannerEntry?.element ?? null;
  }

  bannerEntry.contentElem.dataset.rawContent = trimmedContent;
  bannerEntry.contentElem.innerHTML = processMarkdownContent(trimmedContent);

  return bannerEntry.element;
}

/**
 * Format a model response with markdown rendering
 * @param {object} params - Response parameters
 * @param {string} params.id - Log entry ID
 * @param {string} params.groupId - Group ID
 * @param {string} params.timestamp - Timestamp
 * @param {boolean} params.verbose - Whether to show verbose timestamp
 * @param {object} params.content - Normalized content
 * @param {string} params.level - Log level
 * @returns {HTMLElement|null} Model response element or null
 */
export function formatModelResponse({
  id,
  groupId,
  timestamp,
  verbose,
  content,
  level,
}) {
  const trimmedContent = (content?.decodedText || '').trim();
  if (!trimmedContent) return null;

  const { fullTimestamp, timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );

  const bannerEntry = createBannerEntry({
    logId: id,
    groupId,
    timestamp: fullTimestamp,
    iconClass: 'codicon-sparkle',
    labelText: 'Assistant',
    copyTitle: 'Copy model output',
    contentClass: 'banner-content--model',
    open: true,
  });

  if (!bannerEntry) return null;

  const { element, contentElem, summaryElem } = bannerEntry;

  if (summaryElem) {
    const timestampElem = document.createElement('span');
    timestampElem.classList.add('timestamp');
    timestampElem.title = tooltipTimestamp;
    timestampElem.textContent = verbose ? `[${timeDisplay}]` : '';
    summaryElem.insertBefore(
      timestampElem,
      summaryElem.querySelector('.banner-content-copy'),
    );
  }

  if (contentElem) {
    contentElem.classList.add(`message-${level}`);
    contentElem.dataset.rawContent = trimmedContent;
    contentElem.innerHTML = processMarkdownContent(trimmedContent);
  }

  return element;
}
