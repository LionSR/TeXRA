/**
 * Banner-style formatter for thinking, scratchpad, and model response messages:
 * one collapsible `<wa-details>` shell driven by a per-message-type config.
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

// Local imports - shared transcript model
import type { StreamingTextRow } from '@shared/transcript';
import type { TeXRAIconName } from '@shared/wa/iconNames';

// Local imports - formatter helpers
import { formatDisplayTimestamp } from '../timestampUtils';
import { processMarkdownContent } from '../markdownRenderer';
import { buildDetailsSummary, buildSpillArtifactButton } from '../htmlBuilders';
import type { FormatResult } from '../baseLogFormatter';

type BannerConfig = {
  iconName: TeXRAIconName;
  labelText: string;
  copyTitle: string;
  contentClass: string;
  /** Whether the content also carries the entry's `message-{level}` class. */
  levelClass: boolean;
  /** Whether a verbose entry shows its timestamp in the summary row. */
  showTimestamp: boolean;
  defaultOpen: boolean;
};

// Banner configuration by streaming-text row kind
const BANNER_CONFIG: Record<StreamingTextRow['kind'], BannerConfig> = {
  thinking: {
    iconName: 'lightbulb',
    labelText: 'Thinking',
    copyTitle: 'Copy thinking',
    contentClass: 'banner-content--thinking',
    levelClass: false,
    showTimestamp: false,
    defaultOpen: false,
  },
  scratchpad: {
    iconName: 'pencil',
    labelText: 'Scratchpad',
    copyTitle: 'Copy scratchpad',
    contentClass: 'banner-content--scratchpad',
    levelClass: false,
    showTimestamp: false,
    defaultOpen: false,
  },
  assistant: {
    iconName: 'wand-magic-sparkles',
    labelText: 'Assistant',
    copyTitle: 'Copy model output',
    contentClass: 'banner-content--model',
    levelClass: true,
    showTimestamp: true,
    defaultOpen: true,
  },
};

/**
 * Format thinking, scratchpad, or model-response banner content as a
 * TemplateResult.
 */
export function formatBannerContentTemplate(
  row: StreamingTextRow,
): FormatResult {
  const { id, groupId, timestamp, verbose, level, kind, spillPath } = row;
  const trimmedContent = row.text.full.trim();
  if (!trimmedContent) return null;

  const config = BANNER_CONFIG[kind];
  const { fullTimestamp, timeDisplay, tooltipTimestamp } =
    formatDisplayTimestamp(new Date(timestamp));
  // Auto-expand while streaming in, so the block is visibly "live" instead
  // of hiding the growing text behind a closed summary row; collapses back
  // once finalized (mirrors the "thought for Xs, tap to expand" pattern
  // other chat UIs use for reasoning output). Model responses stay open by
  // default once finalized.
  const isRunning = row.streaming;
  const shouldOpen = isRunning || config.defaultOpen;
  const contentClass = config.levelClass
    ? `${config.contentClass} message-${level}`
    : config.contentClass;
  // While still streaming in, skip the markdown parse on every chunk and
  // show the raw text — the banner shell (icon/label/chevron) stays the
  // same either way; only the content upgrades to rendered markdown once
  // the stream finalizes. banner-content--streaming preserves newlines
  // (raw text has no <p>/<br> tags to do it for us, unlike markdown HTML).
  // prettier-ignore
  const contentTemplate = isRunning
    ? html`<div class="banner-content banner-content--streaming log-entry-content ${contentClass}">${trimmedContent}</div>`
    : html`<div class="banner-content markdown-content log-entry-content ${contentClass}">${unsafeHTML(processMarkdownContent(trimmedContent))}</div>`;

  // prettier-ignore
  return html`<wa-details appearance="plain" icon-placement="start" class="banner-details" ?open=${shouldOpen} data-log-id=${ifDefined(id)} data-group-id=${ifDefined(groupId)} data-timestamp=${ifDefined(fullTimestamp)}>${buildDetailsSummary({
    iconName: config.iconName,
    label: config.labelText,
    timestamp: config.showTimestamp && verbose
      ? { display: `[${timeDisplay}]`, tooltip: tooltipTimestamp }
      : undefined,
    copyButton: {
      title: config.copyTitle,
      content: trimmedContent,
    },
    extraContent: spillPath
      ? buildSpillArtifactButton(spillPath)
      : undefined,
  })}${contentTemplate}</wa-details>`;
}
