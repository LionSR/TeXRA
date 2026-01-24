// Local imports
import { buildBannerEntry } from '../baseLogFormatter';
import { formatTimestamp } from '../timestampUtils';
import { extractTrimmedContent } from '../normalizers';
import { processMarkdownContent } from '../markdownRenderer';

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

export const formatBannerContent = (
  normalizedPayload: { decodedText?: string },
  contentType: 'Thinking' | 'Scratchpad',
  logId: string,
  groupId: string | undefined,
  timestamp?: number,
): string | null => {
  const { trimmed: trimmedContent, isEmpty } =
    extractTrimmedContent(normalizedPayload);
  if (isEmpty) return null;

  const config = BANNER_CONFIG[contentType] || BANNER_CONFIG.Thinking;
  const contentHtml = processMarkdownContent(trimmedContent);
  const fullTimestamp = timestamp
    ? formatTimestamp(new Date(timestamp)).fullTimestamp
    : '';

  return buildBannerEntry({
    logId,
    groupId,
    timestamp: fullTimestamp,
    iconClass: config.iconClass,
    labelText: config.labelText,
    copyTitle: config.copyTitle,
    contentClass: config.contentClass,
    open: false,
    contentHtml,
    rawContent: trimmedContent,
  });
};

export const formatModelResponse = (params: {
  id: string;
  groupId?: string;
  timestamp: number;
  verbose?: boolean;
  content?: { decodedText?: string };
  level?: string;
}): string | null => {
  const trimmedContent = (params.content?.decodedText || '').trim();
  if (!trimmedContent) return null;

  const { fullTimestamp, timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(params.timestamp),
  );
  const summaryExtras = params.verbose
    ? `<span class="timestamp" title="${tooltipTimestamp}">[${timeDisplay}]</span>`
    : '';

  return buildBannerEntry({
    logId: params.id,
    groupId: params.groupId,
    timestamp: fullTimestamp,
    iconClass: 'codicon-sparkle',
    labelText: 'Assistant',
    copyTitle: 'Copy model output',
    contentClass: `banner-content--model message-${params.level ?? 'info'}`,
    open: true,
    contentHtml: processMarkdownContent(trimmedContent),
    rawContent: trimmedContent,
    summaryExtras,
  });
};
