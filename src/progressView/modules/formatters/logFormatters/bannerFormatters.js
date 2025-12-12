/**
 * Banner-style formatters for thinking, scratchpad, and model response messages.
 */

import { createBannerEntry } from '../baseLogFormatter.js';
import { formatTimestamp } from '../timestampUtils.js';
import { extractTrimmedContent } from '../normalizers.js';
import { processMarkdownContent } from '../markdownRenderer.js';

/**
 * Format thinking or scratchpad banner content
 * @param {object} normalizedPayload - Normalized payload with decodedText
 * @param {string} contentType - 'Thinking' or 'Scratchpad'
 * @param {string} logId - Log entry ID
 * @param {string} groupId - Group ID
 * @param {string} timestamp - Timestamp
 * @returns {HTMLElement|null} Banner element or null
 */
export const formatBannerContent = (
  normalizedPayload,
  contentType,
  logId,
  groupId,
  timestamp,
) => {
  const { trimmed: trimmedContent, isEmpty } =
    extractTrimmedContent(normalizedPayload);
  if (isEmpty) return null;

  const parsedMarkdown = processMarkdownContent(trimmedContent);
  const isThinking = contentType.includes('Thinking');
  const bannerEntry = createBannerEntry({
    logId,
    groupId,
    timestamp,
    iconClass: isThinking ? 'codicon-lightbulb' : 'codicon-pencil',
    labelText: isThinking ? 'Thinking' : 'Scratchpad',
    copyTitle: isThinking ? 'Copy thinking' : 'Copy scratchpad',
    contentClass: isThinking
      ? 'banner-content--thinking'
      : 'banner-content--scratchpad',
    open: false,
  });

  if (!bannerEntry || !bannerEntry.contentElem) {
    return bannerEntry ? bannerEntry.element : null;
  }

  bannerEntry.contentElem.dataset.rawContent = trimmedContent;
  bannerEntry.contentElem.innerHTML = parsedMarkdown;

  return bannerEntry.element;
};

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
export const formatModelResponse = ({
  id,
  groupId,
  timestamp,
  verbose,
  content,
  level,
}) => {
  if (!content) {
    return null;
  }

  const decodedContent = content.decodedText || '';
  const trimmedContent = decodedContent.trim();
  if (!trimmedContent) {
    return null;
  }

  const date = new Date(timestamp);
  const { fullTimestamp, timeDisplay, tooltipTimestamp } =
    formatTimestamp(date);

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

  if (!bannerEntry) {
    return null;
  }

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
};
