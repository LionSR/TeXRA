/**
 * Message-style formatters for user messages, errors, and progress status.
 * These formatters use logMessage.text and logMessage.data directly.
 *
 * Uses Lit templates for declarative DOM construction.
 *
 * IMPORTANT: Lit templates preserve whitespace literally. Multi-line templates with
 * indentation will render with unwanted spaces in the output. Always use single-line
 * templates with `// prettier-ignore` to prevent whitespace issues.
 */

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/details/details.js';

// Local imports - shared schemas
import {
  ErrorLogDataSchema,
  type ErrorLogData,
  type LogMessageData,
} from '@shared/schemas';

// Local imports - shared utilities
import { TEXRA_ICON_LIBRARY, waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - Lit template utilities
import {
  html,
  when,
  classMap,
  ifDefined,
  type FormatResult,
} from '../litTemplates';

// Local imports - formatter helpers
import { stringifyWithLanguage } from '../parseUtils';
import { formatDisplayTimestamp } from '../timestampUtils';
import { ICON_BY_LEVEL } from '../constants';
import { registerCopyContent } from '../copyContentStore';

/** Format user message entry as TemplateResult. */
export function formatUserMessageTemplate(
  message: LogMessageData,
): FormatResult {
  const { id, text, timestamp } = message;
  // prettier-ignore
  return html`<user-message .text=${text ?? ''} .logId=${id} .timestamp=${timestamp}></user-message>`;
}

/** Format progress status entry as TemplateResult. */
export function formatProgressStatusTemplate(
  message: LogMessageData,
): FormatResult {
  const { level = 'info', id, groupId, timestamp, text, data } = message;
  const { fullTimestamp, timeDisplay, tooltipTimestamp } =
    formatDisplayTimestamp(new Date(timestamp));

  const summaryText = (text ?? '').trim() || 'Status update';
  const detailText = stringifyWithLanguage(data).text;
  const levelIcon = waIcon(ICON_BY_LEVEL[level], {
    className: `log-level-icon log-level-icon--${level}`,
    label: level === 'error' || level === 'warn' ? level : undefined,
  });

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

// Error detail fields to render in the flat banner, in display order.
// `satisfies` ties each name to ErrorLogData's keys so adding/renaming/removing
// a schema field becomes a type error here — no silent drift.
// Fields omitted on purpose: streamDiagnostics and partialText render
// separately in RetryRequestPanel; cause is not shown in the flat list.
const ERROR_DETAIL_FIELDS = [
  'message',
  'operation',
  'model',
  'provider',
  'statusCode',
  'statusText',
  'isRelayError',
  'userRetryable',
  'requestId',
  'rawMessage',
  'rawErrorBody',
] as const satisfies ReadonlyArray<keyof ErrorLogData>;

/** Format error message as TemplateResult. */
export function formatErrorTemplate(message: LogMessageData): FormatResult {
  const { id, groupId, timestamp, text, data } = message;
  const { fullTimestamp, timeDisplay, tooltipTimestamp } =
    formatDisplayTimestamp(new Date(timestamp));

  // Parse error data with schema - use empty object if invalid
  const parseResult = ErrorLogDataSchema.safeParse(data);
  const errorData: Partial<ErrorLogData> = parseResult.success
    ? parseResult.data
    : {};
  const isRelayError = errorData.isRelayError === true;

  // Build summary text (used for display and duplicate detection)
  const originalSummaryText = (text ?? '').trim() || 'Error occurred';
  const summaryText = isRelayError
    ? `[Relay] ${originalSummaryText}`
    : originalSummaryText;

  // Build error details from parsed data, skipping null/undefined values and a
  // message that merely duplicates the original summary.
  const detailLines = ERROR_DETAIL_FIELDS.flatMap((key) => {
    const value = errorData[key];
    if (value == null) return [];
    if (key === 'message' && value === originalSummaryText) return [];
    // Format objects (like rawErrorBody) as indented JSON
    const displayValue =
      typeof value === 'object'
        ? JSON.stringify(value, null, 2)
        : String(value);
    return [`${key}: ${displayValue}`];
  });

  const detailText = detailLines.join('\n');
  const hasDetails = Boolean(detailText);
  const rawContent = detailText || summaryText;
  const copyId = registerCopyContent(
    rawContent,
    id ? `error:${id}` : undefined,
  );

  // Build modular template parts to avoid overly long single-line templates
  // prettier-ignore
  const detailTemplate = when(hasDetails, () => html`<pre class="error-details">${detailText}</pre>`);
  // prettier-ignore
  const contentTemplate = html`<div class="banner-content log-entry-content banner-content--error">${detailTemplate}</div>`;
  // prettier-ignore
  const labelSpan = html`<span class="label" title=${tooltipTimestamp}>[${timeDisplay}] ${summaryText}</span>`;
  // prettier-ignore
  const copyButton = html`<wa-button class="action-icon-button banner-content-copy" appearance="plain" variant="neutral" size="small" type="button" title="Copy error details" aria-label="Copy error details" data-default-title="Copy error details" data-success-title="Copied!" data-copy-id=${copyId} data-copy-type="banner" ?hidden=${!hasDetails}>${waIcon('copy')}</wa-button>`;
  // Toggle chevron now comes from <wa-details>'s built-in disclosure icon
  // (::part(icon)); banner-details--no-toggle hides that part when there's
  // nothing to expand, replacing the old inline visibility:hidden style.
  // prettier-ignore
  const summaryTemplate = html`<div slot="summary" class="details-summary"><wa-icon library=${TEXRA_ICON_LIBRARY} name="error" class="icon" aria-hidden="true"></wa-icon>${labelSpan}${copyButton}</div>`;
  // prettier-ignore
  return html`<wa-details appearance="plain" class=${classMap({
    'banner-details': true,
    'banner-details--error': true,
    'banner-details--relay-error': isRelayError,
    'banner-details--no-toggle': !hasDetails,
  })} data-log-id=${ifDefined(id)} data-group-id=${ifDefined(groupId)} data-timestamp=${ifDefined(fullTimestamp)}>${summaryTemplate}${contentTemplate}</wa-details>`;
}

/** Format default log message as TemplateResult. */
export function formatDefaultLogMessageTemplate(
  logMessage: LogMessageData,
): FormatResult {
  const { id, text, level, timestamp, groupId, verbose } = logMessage;
  const levelIcon = waIcon(ICON_BY_LEVEL[level], {
    className: `log-level-icon log-level-icon--${level}`,
    label: level === 'error' || level === 'warn' ? level : undefined,
  });
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
