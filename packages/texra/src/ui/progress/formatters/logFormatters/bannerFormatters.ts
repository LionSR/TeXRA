/**
 * Formatter for the two streaming-text rows: the model's answer, which is
 * its text alone, and its thinking, a one-line row that opens.
 * Uses Lit templates with unsafeHTML for markdown content rendering.
 */

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';

// Third-party imports - Lit utilities
import { html, nothing } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';

// Local imports - shared transcript model
import { RESPONSE_CUT_NOTE } from '@ui/copy/responseCut';

// Local imports - formatter helpers
import { formatDisplayTimestamp } from '../timestampUtils';
import { renderMarkdownHtml } from '../markdownRenderer';
import { buildDetailsCard } from '../htmlBuilders';
import type { StreamingTextRow } from '@texra-ai/worldline/transcript';
import type { FormatResult } from '../baseLogFormatter';

/** What differs between the two streaming-text rows' content. */
const CONTENT = {
  thinking: {
    copyTitle: 'Copy thinking',
    className: 'banner-content--thinking',
  },
  assistant: {
    copyTitle: 'Copy model output',
    className: 'banner-content--model',
  },
} as const satisfies Record<StreamingTextRow['kind'], object>;

/**
 * Format thinking or model-response banner content as a
 * TemplateResult.
 */
export function formatBannerContentTemplate(
  row: StreamingTextRow,
): FormatResult {
  const { timestamp, level, kind } = row;
  // The projector leaves no streaming row whose text paints nothing.
  const trimmedContent = row.text.full.trim();

  const config = CONTENT[kind];
  const isRunning = row.streaming;
  // An answer also carries its entry's level class.
  const contentClass =
    kind === 'assistant'
      ? `${config.className} message-${level}`
      : config.className;
  // While still streaming in, skip the markdown parse on every chunk and
  // show the raw text; the content upgrades to rendered markdown once
  // the stream finalizes. banner-content--streaming preserves newlines
  // (raw text has no <p>/<br> tags to do it for us, unlike markdown HTML).
  // prettier-ignore
  const contentTemplate = isRunning
    ? html`<div class="banner-content banner-content--streaming log-entry-content ${contentClass}" aria-busy="true">${trimmedContent}</div>`
    : html`<div class="banner-content markdown-content log-entry-content ${contentClass}">${unsafeHTML(renderMarkdownHtml(trimmedContent))}</div>`;

  if (kind === 'assistant') {
    const time = formatDisplayTimestamp(new Date(timestamp), 'minute');
    // An answer its model ended early says so under its text.
    const cutNote =
      row.cut === undefined
        ? nothing
        : html`<div class="log-line">
            <span class="message-warn">${RESPONSE_CUT_NOTE[row.cut]}</span>
          </div>`;
    // An answer is its text alone: no author line and no frame. Copy and
    // the time sit under it once it has finished, shown on hover.
    // prettier-ignore
    const meta = isRunning ? nothing : html`<div class="message-meta"><copy-button .text=${trimmedContent} .label=${config.copyTitle}></copy-button><time class="message-timestamp" datetime=${new Date(timestamp).toISOString()} title=${time.tooltipTimestamp}>${time.timeDisplay}</time></div>`;
    return html`<div class="assistant-message">
      ${contentTemplate}${cutNote}${meta}
    </div>`;
  }

  // Thinking opens while it streams in, so the block is visibly live, and
  // closes to its one line once finished.
  return buildDetailsCard({
    summary: {
      iconName: 'lightbulb',
      label: 'Thinking',
      copyButton: { title: config.copyTitle, content: trimmedContent },
    },
    body: contentTemplate,
    open: isRunning,
    classes: { 'activity-row': true },
  });
}
