/**
 * Message-style formatters for user messages, errors, and progress status.
 * These formatters use logMessage.text and logMessage.data directly.
 *
 * Uses Lit templates for declarative DOM construction.
 */

// Local imports - shared utilities
import { CHEVRON_RIGHT_CLASS } from '@shared/utils/icons';

// Local imports - Lit template utilities
import {
  html,
  when,
  classMap,
  ifDefined,
  renderToElement,
} from '../litTemplates';

// Local imports - formatter helpers
import { stringifyWithLanguage } from '../parseUtils';
import { formatTimestamp } from '../timestampUtils';
import { EMOJI_BY_LEVEL } from '../constants';

// Local imports - shared schemas
import type { LogMessageData } from '@shared/schemas';

/** Format user message entry (Lit-native). */
export function formatUserMessage(
  text: string,
  logId: string,
  timestamp: number,
): HTMLElement | null {
  const { timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );

  return renderToElement(html`
    <div class="user-message-container">
      <div class="user-message">
        <div class="user-message-header">
          <i class="codicon codicon-comment user-message-icon"></i>
          <span class="user-message-timestamp" title=${tooltipTimestamp}
            >${timeDisplay}</span
          >
        </div>
        <div class="user-message-content" data-log-id=${ifDefined(logId)}>
          ${text ?? ''}
        </div>
      </div>
    </div>
  `);
}

/** Format progress status entry (Lit-native). */
export function formatProgressStatus(
  message: LogMessageData,
): HTMLElement | null {
  const { level = 'info', id, groupId, timestamp, text, data } = message;
  const { fullTimestamp, timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );

  const summaryText = (text ?? '').trim() || 'Status update';
  const detailText = stringifyWithLanguage(data).text;
  const emoji = EMOJI_BY_LEVEL[level] ?? '•';

  return renderToElement(html`
    <div
      data-log-id=${ifDefined(id)}
      data-group-id=${ifDefined(groupId)}
      data-timestamp=${ifDefined(fullTimestamp)}
    >
      <div class="log-line">
        <span class="timestamp" title=${tooltipTimestamp}
          >${emoji} [${timeDisplay}]</span
        >
        <span class=${`message-${level}`}>${summaryText}</span>
      </div>
      ${when(
        detailText,
        () => html`
          <pre class=${`log-line message-${level}`}>${detailText}</pre>
        `,
      )}
    </div>
  `);
}

// Error detail fields in display order (matches ProviderError schema)
const ERROR_DETAIL_FIELDS = [
  'message',
  'operation',
  'model',
  'provider',
  'statusCode',
  'statusText',
  'isRelayError',
  'retryable',
  'requestId',
  'rawMessage',
  'rawErrorBody',
] as const;

/** Format error message as a foldable banner (Lit-native). */
export function formatError(message: LogMessageData): HTMLElement | null {
  const { id, groupId, timestamp, text, data } = message;
  const { fullTimestamp, timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );

  const structured =
    data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const isRelayError = structured.isRelayError === true;

  // Build summary text (used for display and duplicate detection)
  const originalSummaryText = (text ?? '').trim() || 'Error occurred';
  const summaryText = isRelayError
    ? `[Relay] ${originalSummaryText}`
    : originalSummaryText;

  // Build error details from structured data
  const detailLines = ERROR_DETAIL_FIELDS.filter((key) => {
    const value = structured[key];
    // Skip null/undefined values and message if it duplicates the original summary
    return (
      value !== null &&
      value !== undefined &&
      !(key === 'message' && value === originalSummaryText)
    );
  }).map((key) => {
    const value = structured[key];
    // Format objects (like rawErrorBody) as indented JSON
    const displayValue =
      typeof value === 'object'
        ? JSON.stringify(value, null, 2)
        : String(value);
    return `${key}: ${displayValue}`;
  });

  const detailText = detailLines.join('\n');
  const hasDetails = Boolean(detailText);
  const rawContent = detailText || summaryText;

  return renderToElement(html`
    <details
      class=${classMap({
        'banner-details': true,
        'banner-details--error': true,
        'banner-details--relay-error': isRelayError,
      })}
      data-log-id=${ifDefined(id)}
      data-group-id=${ifDefined(groupId)}
      data-timestamp=${ifDefined(fullTimestamp)}
    >
      <summary class="details-summary">
        <i
          class="${CHEVRON_RIGHT_CLASS} toggle-icon"
          style=${hasDetails ? '' : 'visibility: hidden'}
        ></i>
        <i class="codicon icon codicon-error"></i>
        <span class="label" title=${tooltipTimestamp}
          >[${timeDisplay}] ${summaryText}</span
        >
        <vscode-toolbar-button
          class="banner-content-copy"
          icon="copy"
          title="Copy error details"
          aria-label="Copy error details"
          data-default-title="Copy error details"
          data-success-title="Copied!"
          ?hidden=${!hasDetails}
        ></vscode-toolbar-button>
      </summary>
      <div
        class="banner-content log-entry-content banner-content--error"
        data-raw-content=${rawContent}
      >
        ${when(
          hasDetails,
          () => html`<pre class="error-details">${detailText}</pre>`,
        )}
      </div>
    </details>
  `);
}

/** Format default log message (Lit-native). */
export function formatDefaultLogMessage(
  logMessage: LogMessageData,
): HTMLElement | null {
  const { id, text, level, timestamp, groupId, verbose } = logMessage;
  const emoji = EMOJI_BY_LEVEL[level] ?? '•';
  const { fullTimestamp, timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );

  const timestampContent = verbose ? `${emoji} [${timeDisplay}]` : emoji;

  return renderToElement(html`
    <div
      class="log-line"
      data-log-id=${id}
      data-group-id=${ifDefined(groupId)}
      data-full-timestamp=${fullTimestamp}
    >
      <span class="timestamp" title=${tooltipTimestamp}
        >${timestampContent}</span
      >
      ${when(
        verbose,
        () => html`
          <span class=${`level-${level}`}
            >${level.toUpperCase().padEnd(8)}</span
          >
        `,
      )}
      <span class=${`message-${level}`}>${text}</span>
    </div>
  `);
}
