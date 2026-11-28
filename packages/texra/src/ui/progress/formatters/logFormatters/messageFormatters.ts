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
import { truncateWithEllipsis } from '@texra-ai/worldline/schemas';
import { html, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { when } from 'lit/directives/when.js';

// Local imports - shared schemas and utilities
import { LOG_LEVEL_LOOK } from '@ui/copy/logLevels';
import {
  messageSenderHeading,
  messageSenderLabel,
} from '@ui/copy/messageSender';
import { errorRowText } from '@ui/copy/modelAccess';
import { SessionUiEvents } from '@ui/progress/uiEvents';
import { renderIconActionButton } from '@ui/wa/actionButtons';
import type { IconName } from '@ui/wa/iconNames';
import { waIcon } from '@ui/wa/webAwesomeIcons';

// Local imports - formatter helpers
import { formatDisplayTimestamp } from '../timestampUtils';
import {
  buildCopyButton,
  buildDetailsCard,
  buildDetailsSummary,
} from '../htmlBuilders';
import { renderMarkdownHtml } from '../markdownRenderer';
import type { LogLevel } from '@texra-ai/worldline/schemas';
import type {
  ErrorRow,
  LogRow,
  MessageSender,
  ProgressStatusRow,
  UserRow,
} from '@texra-ai/worldline/transcript';
import type { FormatResult } from '../baseLogFormatter';

/** Level-decorated icon shared by the progress-status and default formatters;
 *  its colour comes from the `log-level-icon--{level}` classes in logEntryStyles. */
function buildLevelIcon(level: LogLevel): TemplateResult {
  return waIcon(LOG_LEVEL_LOOK[level].icon, {
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

/** Row width for a received message's first line; the body has all of it. */
const RECEIVED_PREVIEW_MAX_CHARS = 120;

const SENDER_ICON = {
  run: 'reply',
  notification: 'circle-info',
  self: 'clock',
} as const satisfies Record<MessageSender['kind'], IconName>;

/**
 * A message the run took from another run, a host's notice or its own
 * note: one line, as a tool call is, naming who sent it and how it starts.
 * A message longer than that line opens to all of it. A run's line also
 * opens that run. It is never the person's bubble.
 */
function formatReceivedMessageTemplate(
  row: UserRow,
  sender: MessageSender,
): TemplateResult {
  const text = row.text.full.trim();
  const from = messageSenderLabel(sender);
  const open =
    sender.kind === 'run' && sender.inSession
      ? renderIconActionButton({
          icon: 'arrow-up-right-from-square',
          label: `Open ${from}`,
          title: `Open ${from}`,
          onClick: (event) => {
            // The line's own click opens the message; this opens the run.
            event.stopPropagation();
            event.currentTarget?.dispatchEvent(
              SessionUiEvents.surface({ kind: 'select', runId: sender.runId }),
            );
          },
        })
      : undefined;
  const [head = '', ...rest] = text.split('\n');
  const summary = {
    iconName: SENDER_ICON[sender.kind],
    label: messageSenderHeading(sender, text) ?? '',
    labelClass: 'tool-use-title',
    detail: truncateWithEllipsis(head, RECEIVED_PREVIEW_MAX_CHARS),
    extraContent: open,
  };
  // Nothing to open when the line already says all of it.
  if (rest.length === 0 && head.length <= RECEIVED_PREVIEW_MAX_CHARS)
    return html`<div class="activity-row received-line">
      ${buildDetailsSummary(summary)}
    </div>`;
  return buildDetailsCard({
    summary,
    // renderMarkdownHtml uses MarkdownIt with html:false.
    body: html`<div class="banner-content markdown-content log-entry-content">
      ${unsafeHTML(renderMarkdownHtml(text))}
    </div>`,
    classes: { 'activity-row': true },
  });
}

/** Format user message entry as TemplateResult. */
export function formatUserMessageTemplate(row: UserRow): FormatResult {
  if (row.sender !== undefined)
    return formatReceivedMessageTemplate(row, row.sender);
  const { timestamp, scriptSummary, forkAt, media } = row;
  // prettier-ignore
  return html`<user-message .text=${row.text.full} .timestamp=${timestamp} .scriptSummary=${scriptSummary ?? null} .forkAt=${forkAt ?? null} .media=${media}></user-message>`;
}

/** Format progress status entry as TemplateResult. */
export function formatProgressStatusTemplate(
  row: ProgressStatusRow,
): FormatResult {
  const { level, timestamp } = row;
  const summaryText = row.summary.full;

  // prettier-ignore
  return html`<div
    ><div class="log-line">${logLineTimestamp(timestamp, level, true)} <span class=${`message-${level}`}>${summaryText}</span></div></div>`;
}

/**
 * Format error message as TemplateResult. The detail field set and its display
 * order are the row's, and a model failure reads in the app's words
 * (`errorRowText`).
 */
export function formatErrorTemplate(row: ErrorRow): FormatResult {
  const { timestamp } = row;
  const { timeDisplay, tooltipTimestamp } = formatDisplayTimestamp(
    new Date(timestamp),
    'minute',
  );

  const worded = errorRowText(row);
  const summaryText = worded.summary;
  const detailText = worded.detailText.full;
  const hasDetails = row.details.length > 0;
  const rawContent = detailText || summaryText;

  // Do not expose a disclosure control when the row has nothing to reveal.
  // The level icon supplies a non-color error cue for the static row.
  if (!hasDetails) {
    // prettier-ignore
    return html`<div class="log-line">${logLineTimestamp(timestamp, 'error', true)} <span class="message-error">${summaryText}</span></div>`;
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
  return html`<wa-details appearance="plain" icon-placement="end" class="banner-details banner-details--error tone-danger message-disclosure">${summaryTemplate}${contentTemplate}</wa-details>`;
}

/** Format a plain log line as TemplateResult. */
export function formatDefaultLogMessageTemplate(row: LogRow): FormatResult {
  const { level, timestamp, verbose } = row;
  const text = row.text.full;

  // prettier-ignore
  return html`<div
      class="log-line"
    >${logLineTimestamp(timestamp, level, verbose === true)}${when(
        verbose,
        () => html` <span class=${`level-${level}`}>${level.toUpperCase().padEnd(8)}</span>`,
      )} <span class=${`message-${level}`}>${text}</span></div>`;
}
