/**
 * Banner-style formatters for thinking, scratchpad, and model response messages.
 * Uses Lit templates with unsafeHTML for markdown content rendering.
 */

// Local imports - Lit utilities
import {
  html,
  unsafeHTML,
  classMap,
  ifDefined,
  type FormatResult,
} from '../litTemplates';

// Local imports - formatter helpers
import { formatTimestamp } from '../timestampUtils';
import { processMarkdownContent } from '../markdownRenderer';
import { buildDetailsSummary } from '../htmlBuilders';

// Local imports - shared schemas
import type { LogMessageData } from '@shared/schemas';

// Banner configuration by messageType
const BANNER_CONFIG: Record<
  string,
  {
    iconClass: string;
    labelText: string;
    copyTitle: string;
    contentClass: string;
  }
> = {
  thinking: {
    iconClass: 'codicon-lightbulb',
    labelText: 'Thinking',
    copyTitle: 'Copy thinking',
    contentClass: 'banner-content--thinking',
  },
  scratchpad: {
    iconClass: 'codicon-pencil',
    labelText: 'Scratchpad',
    copyTitle: 'Copy scratchpad',
    contentClass: 'banner-content--scratchpad',
  },
};

/** Format thinking or scratchpad banner content as TemplateResult. */
export function formatBannerContentTemplate(
  message: LogMessageData,
  options?: { defaultOpen?: boolean },
): FormatResult {
  const { id, groupId, timestamp, text, messageType } = message;
  const trimmedContent = (text ?? '').trim();
  if (!trimmedContent) return null;

  const config = BANNER_CONFIG[messageType ?? ''] ?? BANNER_CONFIG.thinking;
  const { fullTimestamp } = formatTimestamp(new Date(timestamp));
  const markdownHtml = processMarkdownContent(trimmedContent);
  const shouldOpen = options?.defaultOpen ?? false;
  // prettier-ignore
  const contentTemplate = html`<div class="banner-content markdown-content log-entry-content ${config.contentClass}" data-raw-content=${trimmedContent}>${unsafeHTML(markdownHtml)}</div>`;

  return html`
    <details
      class="banner-details"
      ?open=${shouldOpen}
      data-log-id=${ifDefined(id)}
      data-group-id=${ifDefined(groupId)}
      data-timestamp=${ifDefined(fullTimestamp)}
    >
      ${buildDetailsSummary({
        iconClass: config.iconClass,
        label: config.labelText,
        copyButton: {
          title: config.copyTitle,
          content: trimmedContent,
          contentId: id ? `banner:${id}` : undefined,
        },
      })}
      ${contentTemplate}
    </details>
  `;
}

/** Format a model response as TemplateResult. */
export function formatModelResponseTemplate(
  message: LogMessageData,
  options?: { defaultOpen?: boolean },
): FormatResult {
  const { id, groupId, timestamp, verbose, text, level } = message;
  const trimmedContent = (text ?? '').trim();
  if (!trimmedContent) return null;

  const { fullTimestamp, timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );
  const markdownHtml = processMarkdownContent(trimmedContent);
  // Model response defaults to open (was hardcoded open before)
  const shouldOpen = options?.defaultOpen ?? true;
  // prettier-ignore
  const contentTemplate = html`<div class=${classMap({
    'banner-content': true,
    'markdown-content': true,
    'log-entry-content': true,
    'banner-content--model': true,
    [`message-${level}`]: true,
  })} data-raw-content=${trimmedContent}>${unsafeHTML(markdownHtml)}</div>`;

  return html`
    <details
      class="banner-details"
      ?open=${shouldOpen}
      data-log-id=${ifDefined(id)}
      data-group-id=${ifDefined(groupId)}
      data-timestamp=${ifDefined(fullTimestamp)}
    >
      ${buildDetailsSummary({
        iconClass: 'codicon-sparkle',
        label: 'Assistant',
        timestamp: verbose
          ? { display: `[${timeDisplay}]`, tooltip: tooltipTimestamp }
          : undefined,
        copyButton: {
          title: 'Copy model output',
          content: trimmedContent,
          contentId: id ? `model:${id}` : undefined,
        },
      })}
      ${contentTemplate}
    </details>
  `;
}
