/**
 * Banner-style formatters for thinking, scratchpad, and model response messages.
 * Uses Lit templates with unsafeHTML for markdown content rendering.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Multi-line templates with
 * indentation will render with unwanted spaces in the output. Always use single-line
 * templates with `// prettier-ignore` to prevent whitespace issues.
 */

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';

// Third-party imports - Lit utilities
import { html } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

import type { LogMessageData } from '@shared/schemas';

// Local imports - formatter helpers
import { formatDisplayTimestamp } from '../timestampUtils';
import { processMarkdownContent } from '../markdownRenderer';
import { buildDetailsSummary } from '../htmlBuilders';
import type { FormatResult } from '../baseLogFormatter';

// Local imports - shared schemas

// Banner configuration by messageType
const BANNER_CONFIG: Record<
  string,
  {
    iconName: string;
    labelText: string;
    copyTitle: string;
    contentClass: string;
  }
> = {
  thinking: {
    iconName: 'lightbulb',
    labelText: 'Thinking',
    copyTitle: 'Copy thinking',
    contentClass: 'banner-content--thinking',
  },
  scratchpad: {
    iconName: 'pencil',
    labelText: 'Scratchpad',
    copyTitle: 'Copy scratchpad',
    contentClass: 'banner-content--scratchpad',
  },
};

/** Format thinking or scratchpad banner content as TemplateResult. */
export function formatBannerContentTemplate(
  message: LogMessageData,
  options?: { defaultOpen?: boolean; isRunning?: boolean },
): FormatResult {
  const { id, groupId, timestamp, text, messageType } = message;
  const trimmedContent = (text ?? '').trim();
  if (!trimmedContent) return null;

  const config = BANNER_CONFIG[messageType ?? ''] ?? BANNER_CONFIG.thinking;
  const { fullTimestamp } = formatDisplayTimestamp(new Date(timestamp));
  // Auto-expand while streaming in, so the block is visibly "live" instead
  // of hiding the growing text behind a closed summary row; collapses back
  // once finalized unless the caller pins it open (mirrors the "thought for
  // Xs, tap to expand" pattern other chat UIs use for reasoning output).
  const shouldOpen = options?.isRunning || (options?.defaultOpen ?? false);
  // While still streaming in, skip the markdown parse on every chunk and
  // show the raw text — the banner shell (icon/label/chevron) stays the
  // same either way; only the content upgrades to rendered markdown once
  // the stream finalizes. banner-content--streaming preserves newlines
  // (raw text has no <p>/<br> tags to do it for us, unlike markdown HTML).
  // prettier-ignore
  const contentTemplate = options?.isRunning
    ? html`<div class="banner-content banner-content--streaming log-entry-content ${config.contentClass}">${trimmedContent}</div>`
    : html`<div class="banner-content markdown-content log-entry-content ${config.contentClass}">${unsafeHTML(processMarkdownContent(trimmedContent))}</div>`;

  // prettier-ignore
  return html`<wa-details appearance="plain" icon-placement="start" class="banner-details" ?open=${shouldOpen} data-log-id=${ifDefined(id)} data-group-id=${ifDefined(groupId)} data-timestamp=${ifDefined(fullTimestamp)}>${buildDetailsSummary({
    iconName: config.iconName,
    label: config.labelText,
    copyButton: {
      title: config.copyTitle,
      content: trimmedContent,
      contentId: id ? `banner:${id}` : undefined,
    },
  })}${contentTemplate}</wa-details>`;
}

/** Format a model response as TemplateResult. */
export function formatModelResponseTemplate(
  message: LogMessageData,
  options?: { defaultOpen?: boolean; isRunning?: boolean },
): FormatResult {
  const { id, groupId, timestamp, verbose, text, level } = message;
  const trimmedContent = (text ?? '').trim();
  if (!trimmedContent) return null;

  const { fullTimestamp, timeDisplay, tooltipTimestamp } =
    formatDisplayTimestamp(new Date(timestamp));
  // Model response defaults to open (was hardcoded open before); also forced
  // open while streaming, same rationale as formatBannerContentTemplate.
  const shouldOpen = options?.isRunning || (options?.defaultOpen ?? true);
  // While still streaming in, skip the markdown parse on every chunk (see
  // formatBannerContentTemplate above for the same tradeoff, including the
  // banner-content--streaming whitespace note).
  // prettier-ignore
  const contentTemplate = options?.isRunning
    ? html`<div class="banner-content banner-content--streaming log-entry-content banner-content--model message-${level}">${trimmedContent}</div>`
    : html`<div class="banner-content markdown-content log-entry-content banner-content--model message-${level}">${unsafeHTML(processMarkdownContent(trimmedContent))}</div>`;

  // prettier-ignore
  return html`<wa-details appearance="plain" icon-placement="start" class="banner-details" ?open=${shouldOpen} data-log-id=${ifDefined(id)} data-group-id=${ifDefined(groupId)} data-timestamp=${ifDefined(fullTimestamp)}>${buildDetailsSummary({
    iconName: 'sparkle',
    label: 'Assistant',
    timestamp: verbose
      ? { display: `[${timeDisplay}]`, tooltip: tooltipTimestamp }
      : undefined,
    copyButton: {
      title: 'Copy model output',
      content: trimmedContent,
      contentId: id ? `model:${id}` : undefined,
    },
  })}${contentTemplate}</wa-details>`;
}
