/**
 * Message-style formatters for user messages, errors, progress status, and
 * plain log lines. Every one of them paints a `TranscriptRow` — the error
 * detail set and the status summary are the row's, not this layer's.
 *
 * Uses Lit templates for declarative DOM construction.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Multi-line templates with
 * indentation will render with unwanted spaces in the output. Always use single-line
 * templates with `// prettier-ignore` to prevent whitespace issues.
 */

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';

// Side-effect import to register the <user-message> custom element
import '@progressView/frontend/components/UserMessage';

// Third-party imports - Lit template utilities
import { html, type TemplateResult } from 'lit';
import { ifDefined } from 'lit/directives/if-defined.js';
import { when } from 'lit/directives/when.js';

// Local imports - shared schemas and utilities
import type { LogLevel } from '@shared/schemas';
import type {
  ErrorRow,
  LogRow,
  PhaseRow,
  ProgressStatusRow,
  UserRow,
  WorkflowTaskRow,
} from '@shared/transcript';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - formatter helpers
import { formatDisplayTimestamp } from '../timestampUtils';
import { ICON_BY_LEVEL } from '../constants';
import { buildCopyButton } from '../htmlBuilders';
import type { FormatResult } from '../baseLogFormatter';

/** Level-decorated icon shared by the progress-status and default formatters. */
function buildLevelIcon(level: LogLevel): TemplateResult {
  return waIcon(ICON_BY_LEVEL[level], {
    className: `log-level-icon log-level-icon--${level}`,
    label: level === 'error' || level === 'warn' ? level : undefined,
  });
}

/** Format user message entry as TemplateResult. */
export function formatUserMessageTemplate(row: UserRow): FormatResult {
  const { id, timestamp, workflowSummary } = row;
  // prettier-ignore
  return html`<user-message .text=${row.text.full} .logId=${id} .timestamp=${timestamp} .workflowSummary=${workflowSummary ?? null}></user-message>`;
}

/** Format progress status entry as TemplateResult. */
export function formatProgressStatusTemplate(
  row: ProgressStatusRow,
): FormatResult {
  const { level, id, groupId, timestamp } = row;
  const { timeDisplay, tooltipTimestamp } = formatDisplayTimestamp(
    new Date(timestamp),
  );

  const summaryText = row.summary.full;
  const detailText = row.detail?.full ?? '';
  const levelIcon = buildLevelIcon(level);

  // prettier-ignore
  return html`<div
      data-log-id=${ifDefined(id)}
      data-group-id=${ifDefined(groupId)}
    ><div class="log-line"><span class="timestamp" title=${tooltipTimestamp}>${levelIcon} [${timeDisplay}]</span> <span class=${`message-${level}`}>${summaryText}</span></div>${when(
        detailText,
        () => html`<pre class=${`log-line message-${level}`}>${detailText}</pre>`,
      )}</div>`;
}

/**
 * Format error message as TemplateResult. The detail field set and its display
 * order are the row's — see `ERROR_DETAIL_FIELDS` in `@shared/transcript`.
 */
export function formatErrorTemplate(row: ErrorRow): FormatResult {
  const { id, groupId, timestamp } = row;
  const { timeDisplay, tooltipTimestamp } = formatDisplayTimestamp(
    new Date(timestamp),
  );

  const summaryText = row.summary.full.trim() || 'Error occurred';
  const detailText = row.detailText.full;
  const hasDetails = row.details.length > 0;
  const rawContent = detailText || summaryText;

  // Do not expose a disclosure control when the row has nothing to reveal.
  // The level icon supplies a non-color error cue for the static row.
  if (!hasDetails) {
    const levelIcon = buildLevelIcon('error');
    // prettier-ignore
    return html`<div class="log-line" data-log-id=${ifDefined(id)} data-group-id=${ifDefined(groupId)}><span class="timestamp" title=${tooltipTimestamp}>${levelIcon} [${timeDisplay}]</span> <span class="message-error">${summaryText}</span></div>`;
  }

  // Build modular template parts to avoid overly long single-line templates.
  // prettier-ignore
  const detailTemplate = html`<pre class="error-details">${detailText}</pre>`;
  // prettier-ignore
  const contentTemplate = html`<div class="banner-content log-entry-content banner-content--error">${detailTemplate}</div>`;
  // prettier-ignore
  const labelSpan = html`<span class="label" title=${tooltipTimestamp}>[${timeDisplay}] ${summaryText}</span>`;
  // The copy button is shared markup (buildCopyButton); the label span is
  // built here because its title carries the formatted timestamp.
  // prettier-ignore
  const copyButton = buildCopyButton('Copy error details', {
    content: rawContent,
  });
  // prettier-ignore
  const summaryTemplate = html`<div slot="summary" class="details-summary">${waIcon('circle-exclamation', { className: 'icon' })}${labelSpan}${copyButton}</div>`;
  // prettier-ignore
  return html`<wa-details appearance="plain" icon-placement="start" class="banner-details banner-details--error" data-log-id=${ifDefined(id)} data-group-id=${ifDefined(groupId)}>${summaryTemplate}${contentTemplate}</wa-details>`;
}

function plainLineText(row: LogRow | PhaseRow | WorkflowTaskRow): string {
  switch (row.kind) {
    case 'phase':
      return row.heading;
    case 'workflowTask':
      return row.line;
    case 'log':
      return row.text.full;
  }
}

/**
 * Format a plain log line as TemplateResult. `PhaseRow` and
 * `WorkflowTaskRow` share the shape and are in the union to keep the row
 * dispatch exhaustive; this host routes every phase heading to its
 * task-group surface (see `logSlice`) and every workflow call to the run
 * board (`workflow-run-board`, painted whenever the fold set
 * `transcript.run`), so both arms are unreachable here today: a call only
 * lands on this line for a legacy import with no run identity.
 */
export function formatDefaultLogMessageTemplate(
  row: LogRow | PhaseRow | WorkflowTaskRow,
): FormatResult {
  const { id, level, timestamp, groupId, verbose } = row;
  const text = plainLineText(row);
  const levelIcon = buildLevelIcon(level);
  const { timeDisplay, tooltipTimestamp } = formatDisplayTimestamp(
    new Date(timestamp),
  );

  const timestampContent = verbose
    ? html`${levelIcon} [${timeDisplay}]`
    : levelIcon;

  // prettier-ignore
  return html`<div
      class="log-line"
      data-log-id=${id}
      data-group-id=${ifDefined(groupId)}
    ><span class="timestamp" title=${tooltipTimestamp}>${timestampContent}</span>${when(
        verbose,
        () => html` <span class=${`level-${level}`}>${level.toUpperCase().padEnd(8)}</span>`,
      )} <span class=${`message-${level}`}>${text}</span></div>`;
}
