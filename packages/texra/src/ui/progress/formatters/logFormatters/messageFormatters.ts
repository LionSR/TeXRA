/**
 * Message-style formatters for user messages, errors, progress status, and
 * plain log lines. Every one of them paints a `TranscriptRow` — the error
 * detail set and the status summary are the row's, not this layer's.
 *
 * Uses Lit templates for declarative DOM construction.
 */

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';

// Side-effect import to register the <user-message> custom element
import '@ui/progress/components/UserMessage';

// Third-party imports - Lit template utilities
import { html, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { when } from 'lit/directives/when.js';

// Local imports - shared schemas and utilities
import { errorRowText, quotaFallbackNoticeText } from '@ui/copy/modelAccess';
import { waIcon } from '@ui/wa/webAwesomeIcons';

// Local imports - formatter helpers
import { formatDisplayTimestamp } from '../timestampUtils';
import { ICON_BY_LEVEL } from '../constants';
import { buildCopyButton } from '../htmlBuilders';
import type { LogLevel } from '@texra-ai/harness/schemas';
import type {
  ErrorRow,
  LogRow,
  ProgressStatusRow,
  UserRow,
} from '@texra-ai/harness/transcript';
import type { FormatResult } from '../baseLogFormatter';

/** Level-decorated icon shared by the progress-status and default formatters. */
function buildLevelIcon(level: LogLevel): TemplateResult {
  return waIcon(ICON_BY_LEVEL[level], {
    className: `log-level-icon log-level-icon--${level}`,
    label: level === 'error' || level === 'warn' ? level : undefined,
  });
}

/** A log line's leading cell: its level icon, then its time of day when
 *  `withTime`; the full moment is its tooltip. */
function logLineTimestamp(
  timestamp: number,
  level: LogLevel,
  withTime: boolean,
): TemplateResult {
  const { timeDisplay, tooltipTimestamp } = formatDisplayTimestamp(
    new Date(timestamp),
  );
  const levelIcon = buildLevelIcon(level);
  // prettier-ignore
  return html`<span class="timestamp" title=${tooltipTimestamp}>${withTime ? html`${levelIcon} [${timeDisplay}]` : levelIcon}</span>`;
}

/** Format user message entry as TemplateResult. */
export function formatUserMessageTemplate(row: UserRow): FormatResult {
  const { id, timestamp, scriptSummary, forkAt, media } = row;
  // prettier-ignore
  return html`<user-message .text=${row.text.full} .logId=${id} .timestamp=${timestamp} .scriptSummary=${scriptSummary ?? null} .forkAt=${forkAt ?? null} .media=${media ?? []}></user-message>`;
}

/** Format progress status entry as TemplateResult. */
export function formatProgressStatusTemplate(
  row: ProgressStatusRow,
): FormatResult {
  const { level, id, timestamp } = row;
  const summaryText =
    row.quotaFallback === undefined
      ? row.summary.full
      : quotaFallbackNoticeText(row.quotaFallback);

  // prettier-ignore
  return html`<div
      data-log-id=${ifDefined(id)}
    ><div class="log-line">${logLineTimestamp(timestamp, level, true)} <span class=${`message-${level}`}>${summaryText}</span></div></div>`;
}

/**
 * Format error message as TemplateResult. The detail field set and its display
 * order are the row's, and a model failure reads in the app's words
 * (`errorRowText`).
 */
export function formatErrorTemplate(row: ErrorRow): FormatResult {
  const { id, timestamp } = row;
  const { timeDisplay, tooltipTimestamp } = formatDisplayTimestamp(
    new Date(timestamp),
    'minute',
  );

  const worded = errorRowText(row);
  const summaryText = worded.summary.trim() || 'Error occurred';
  const detailText = worded.detailText.full;
  const hasDetails = row.details.length > 0;
  const rawContent = detailText || summaryText;

  // Do not expose a disclosure control when the row has nothing to reveal.
  // The level icon supplies a non-color error cue for the static row.
  if (!hasDetails) {
    // prettier-ignore
    return html`<div class="log-line" data-log-id=${ifDefined(id)}>${logLineTimestamp(timestamp, 'error', true)} <span class="message-error">${summaryText}</span></div>`;
  }

  // Build modular template parts to avoid overly long single-line templates.
  // prettier-ignore
  const detailTemplate = html`<pre class="error-details">${detailText}</pre>`;
  // prettier-ignore
  const contentTemplate = html`<div class="banner-content log-entry-content banner-content--error">${detailTemplate}</div>`;
  // prettier-ignore
  const labelSpan = html`<span class="label">${summaryText}</span>`;
  const timestampLabel = html`<time
    class="error-timestamp message-timestamp"
    datetime=${new Date(timestamp).toISOString()}
    title=${tooltipTimestamp}
    >${timeDisplay}</time
  >`;
  // prettier-ignore
  const copyButton = buildCopyButton('Copy error details', rawContent);
  // prettier-ignore
  const summaryTemplate = html`<div slot="summary" class="details-summary message-header"><span class="message-label">${waIcon('circle-exclamation', { className: 'icon' })}${labelSpan}</span>${timestampLabel}${copyButton}</div>`;
  // prettier-ignore
  return html`<wa-details appearance="plain" icon-placement="end" class="banner-details banner-details--error message-disclosure" data-log-id=${ifDefined(id)}>${summaryTemplate}${contentTemplate}</wa-details>`;
}

/** Format a plain log line as TemplateResult. */
export function formatDefaultLogMessageTemplate(row: LogRow): FormatResult {
  const { id, level, timestamp, verbose } = row;
  const text = row.text.full;

  // prettier-ignore
  return html`<div
      class="log-line"
      data-log-id=${id}
    >${logLineTimestamp(timestamp, level, verbose === true)}${when(
        verbose,
        () => html` <span class=${`level-${level}`}>${level.toUpperCase().padEnd(8)}</span>`,
      )} <span class=${`message-${level}`}>${text}</span></div>`;
}
