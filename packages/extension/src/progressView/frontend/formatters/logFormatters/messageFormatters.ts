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
import { classMap } from 'lit/directives/class-map.js';
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
  const { fullTimestamp, timeDisplay, tooltipTimestamp } =
    formatDisplayTimestamp(new Date(timestamp));

  const summaryText = row.summary.full;
  const detailText = row.detail?.full ?? '';
  const levelIcon = buildLevelIcon(level);

  // prettier-ignore
  return html`<div
      data-log-id=${ifDefined(id)}
      data-group-id=${ifDefined(groupId)}
      data-timestamp=${ifDefined(fullTimestamp)}
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
  const { fullTimestamp, timeDisplay, tooltipTimestamp } =
    formatDisplayTimestamp(new Date(timestamp));

  const summaryText = row.summary.full.trim() || 'Error occurred';
  const detailText = row.detailText.full;
  const hasDetails = row.details.length > 0;
  const rawContent = detailText || summaryText;

  // Build modular template parts to avoid overly long single-line templates
  // prettier-ignore
  const detailTemplate = when(hasDetails, () => html`<pre class="error-details">${detailText}</pre>`);
  // prettier-ignore
  const contentTemplate = html`<div class="banner-content log-entry-content banner-content--error">${detailTemplate}</div>`;
  // prettier-ignore
  const labelSpan = html`<span class="label" title=${tooltipTimestamp}>[${timeDisplay}] ${summaryText}</span>`;
  // The copy button is shared markup (buildCopyButton); the label span is
  // built here because its title carries the formatted timestamp.
  // prettier-ignore
  const copyButton = buildCopyButton('Copy error details', {
    hidden: !hasDetails,
    content: rawContent,
    contentId: id ? `error:${id}` : undefined,
  });
  // Toggle chevron now comes from <wa-details>'s built-in disclosure icon
  // (::part(icon)); banner-details--no-toggle hides that part when there's
  // nothing to expand, replacing the old inline visibility:hidden style.
  // prettier-ignore
  const summaryTemplate = html`<div slot="summary" class="details-summary">${waIcon('circle-exclamation', { className: 'icon' })}${labelSpan}${copyButton}</div>`;
  // prettier-ignore
  return html`<wa-details appearance="plain" icon-placement="start" class=${classMap({
    'banner-details': true,
    'banner-details--error': true,
    'banner-details--no-toggle': !hasDetails,
  })} data-log-id=${ifDefined(id)} data-group-id=${ifDefined(groupId)} data-timestamp=${ifDefined(fullTimestamp)}>${summaryTemplate}${contentTemplate}</wa-details>`;
}

/**
 * Format a plain log line as TemplateResult. `PhaseRow` shares the shape and is
 * in the union to keep the row dispatch exhaustive; this host routes every
 * phase heading to its task-group surface (see `logSlice`), so that arm is
 * unreachable here today.
 */
export function formatDefaultLogMessageTemplate(
  row: LogRow | PhaseRow,
): FormatResult {
  const { id, level, timestamp, groupId, verbose } = row;
  const text = row.kind === 'phase' ? row.heading : row.text.full;
  const levelIcon = buildLevelIcon(level);
  const { fullTimestamp, timeDisplay, tooltipTimestamp } =
    formatDisplayTimestamp(new Date(timestamp));

  const timestampContent = verbose
    ? html`${levelIcon} [${timeDisplay}]`
    : levelIcon;

  // prettier-ignore
  return html`<div
      class="log-line"
      data-log-id=${id}
      data-group-id=${ifDefined(groupId)}
      data-full-timestamp=${fullTimestamp}
    ><span class="timestamp" title=${tooltipTimestamp}>${timestampContent}</span>${when(
        verbose,
        () => html` <span class=${`level-${level}`}>${level.toUpperCase().padEnd(8)}</span>`,
      )} <span class=${`message-${level}`}>${text}</span></div>`;
}
