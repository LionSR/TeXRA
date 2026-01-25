/**
 * Banner-style formatters for thinking, scratchpad, and model response messages.
 */

// Local imports - formatter helpers
import { createBannerEntry } from '../baseLogFormatter';
import { formatTimestamp } from '../timestampUtils';
import { extractTrimmedContent } from '../normalizers';
import { processMarkdownContent } from '../markdownRenderer';
import type { NormalizedPayload } from '../normalizers';

// Local imports - shared schemas
import type { LogLevel } from '@shared/schemas';

// Banner configuration by content type
const BANNER_CONFIG: Record<
  string,
  {
    iconClass: string;
    labelText: string;
    copyTitle: string;
    contentClass: string;
  }
> = {
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

/** Format thinking or scratchpad banner content. */
export function formatBannerContent(
  normalizedPayload: NormalizedPayload,
  contentType: string,
  logId: string,
  groupId: string | undefined,
  timestamp: number,
): HTMLElement | null {
  const { trimmed: trimmedContent, isEmpty } =
    extractTrimmedContent(normalizedPayload);
  if (isEmpty) return null;

  const config = BANNER_CONFIG[contentType] || BANNER_CONFIG.Thinking;
  const { fullTimestamp } = formatTimestamp(new Date(timestamp));
  const bannerEntry = createBannerEntry({
    logId,
    groupId,
    timestamp: fullTimestamp,
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

/** Format a model response with markdown rendering. */
export function formatModelResponse({
  id,
  groupId,
  timestamp,
  verbose,
  content,
  level,
}: {
  id: string;
  groupId?: string;
  timestamp: number;
  verbose?: boolean;
  content: NormalizedPayload;
  level: LogLevel;
}): HTMLElement | null {
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
