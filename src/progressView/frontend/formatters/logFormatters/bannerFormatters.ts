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
  renderToElement,
} from '../litTemplates';

// Local imports - formatter helpers
import { formatTimestamp } from '../timestampUtils';
import { processMarkdownContent } from '../markdownRenderer';
import { initToggleIcon, buildDetailsSummary } from '../htmlBuilders';

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
  text: string,
  contentType: string,
  logId: string,
  groupId: string | undefined,
  timestamp: number,
): HTMLElement | null {
  const trimmedContent = (text ?? '').trim();
  if (!trimmedContent) return null;

  const config = BANNER_CONFIG[contentType] ?? BANNER_CONFIG.Thinking;
  const { fullTimestamp } = formatTimestamp(new Date(timestamp));
  const markdownHtml = processMarkdownContent(trimmedContent);

  const template = html`
    <details
      class="banner-details"
      data-log-id=${ifDefined(logId)}
      data-group-id=${ifDefined(groupId)}
      data-timestamp=${ifDefined(fullTimestamp)}
    >
      ${buildDetailsSummary({
        iconClass: config.iconClass,
        label: config.labelText,
        copyButton: { title: config.copyTitle },
      })}
      <div
        class="banner-content log-entry-content ${config.contentClass}"
        data-raw-content=${trimmedContent}
      >
        ${unsafeHTML(markdownHtml)}
      </div>
    </details>
  `;

  const element = renderToElement(template);
  if (element) initToggleIcon(element, false);
  return element;
}

/** Format a model response with markdown rendering. */
export function formatModelResponse({
  id,
  groupId,
  timestamp,
  verbose,
  text,
  level,
}: {
  id: string;
  groupId?: string;
  timestamp: number;
  verbose?: boolean;
  text: string;
  level: LogLevel;
}): HTMLElement | null {
  const trimmedContent = (text ?? '').trim();
  if (!trimmedContent) return null;

  const { fullTimestamp, timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );
  const markdownHtml = processMarkdownContent(trimmedContent);

  const template = html`
    <details
      class="banner-details"
      open
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
        copyButton: { title: 'Copy model output' },
      })}
      <div
        class=${classMap({
          'banner-content': true,
          'log-entry-content': true,
          'banner-content--model': true,
          [`message-${level}`]: true,
        })}
        data-raw-content=${trimmedContent}
      >
        ${unsafeHTML(markdownHtml)}
      </div>
    </details>
  `;

  const element = renderToElement(template);
  if (element) initToggleIcon(element, true);
  return element;
}
