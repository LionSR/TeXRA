// Local imports
import { buildBannerEntry } from '../baseLogFormatter';
import { EMOJI_BY_LEVEL } from '../constants';
import { encodeHtml } from '../htmlEncoding';
import { wrapInPre } from '../htmlBuilders';
import { stringifyWithLanguage } from '../normalizers';
import { formatTimestamp } from '../timestampUtils';

export const formatUserMessage = (
  normalizedPayload: { decodedText?: string },
  logId: string,
  timestamp: number,
): string | null => {
  const { timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );
  const messageText = normalizedPayload?.decodedText || '';
  const content = encodeHtml(messageText);

  return `
    <div class="user-message-container">
      <div class="user-message" data-log-id="${encodeHtml(logId)}">
        <div class="user-message-header">
          <i class="codicon codicon-comment user-message-icon"></i>
          <span class="user-message-timestamp" title="${tooltipTimestamp}">${encodeHtml(
            timeDisplay,
          )}</span>
        </div>
        <div class="user-message-content">${content}</div>
      </div>
    </div>
  `;
};

export const formatProgressStatus = (message: {
  normalizedPayload?: { decodedText?: string; structured?: unknown };
  level?: string;
  id?: string;
  groupId?: string;
  timestamp?: number;
  text?: string;
}): string => {
  const {
    normalizedPayload = {},
    level = 'info',
    id,
    groupId,
    timestamp = Date.now(),
    text = '',
  } = message;
  const { fullTimestamp, timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );

  const summaryText =
    (normalizedPayload.decodedText || text || '').trim() || 'Status update';
  const detailText = stringifyWithLanguage(normalizedPayload.structured).text;
  const emoji = EMOJI_BY_LEVEL[level] || '•';
  const dataAttrs = [
    id ? `data-log-id="${encodeHtml(id)}"` : '',
    groupId ? `data-group-id="${encodeHtml(groupId)}"` : '',
    `data-full-timestamp="${encodeHtml(fullTimestamp)}"`,
  ]
    .filter(Boolean)
    .join(' ');

  const detailSection = detailText
    ? `<pre class="log-line message-${encodeHtml(level)}">${encodeHtml(
        detailText,
      )}</pre>`
    : '';

  return `
    <div ${dataAttrs}>
      <div class="log-line">
        <span class="timestamp" title="${tooltipTimestamp}">${emoji} [${timeDisplay}]</span>
        <span class="message-${encodeHtml(level)}">${encodeHtml(
          summaryText,
        )}</span>
      </div>
      ${detailSection}
    </div>
  `;
};

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
];

export const formatError = (message: {
  normalizedPayload?: {
    decodedText?: string;
    structured?: Record<string, any>;
  };
  id?: string;
  groupId?: string;
  timestamp?: number;
}): string | null => {
  const {
    normalizedPayload = {},
    id,
    groupId,
    timestamp = Date.now(),
  } = message;
  const { fullTimestamp, timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );

  const structured = normalizedPayload.structured ?? {};
  const isRelayError = structured.isRelayError === true;

  const originalSummaryText =
    (normalizedPayload.decodedText || '').trim() || 'Error occurred';
  const summaryText = isRelayError
    ? `[Relay] ${originalSummaryText}`
    : originalSummaryText;

  const detailLines = ERROR_DETAIL_FIELDS.filter((key) => {
    const value = structured[key];
    return (
      value != null && !(key === 'message' && value === originalSummaryText)
    );
  }).map((key) => {
    const value = structured[key];
    const displayValue =
      typeof value === 'object'
        ? JSON.stringify(value, null, 2)
        : String(value);
    return `${key}: ${displayValue}`;
  });

  const detailText = detailLines.join('\n');

  const contentHtml = detailText
    ? `<pre class="error-details">${encodeHtml(detailText)}</pre>`
    : encodeHtml(summaryText);

  return buildBannerEntry({
    logId: id,
    groupId,
    timestamp: fullTimestamp,
    iconClass: 'codicon-error',
    labelText: `[${timeDisplay}] ${summaryText}`,
    copyTitle: 'Copy error details',
    contentClass: 'banner-content--error',
    extraClasses: [
      'banner-details--error',
      isRelayError ? 'banner-details--relay-error' : '',
    ].filter(Boolean),
    open: false,
    contentHtml,
    rawContent: detailText || summaryText,
    summaryExtras: `<span class="timestamp" title="${tooltipTimestamp}"></span>`,
    showCopy: Boolean(detailText),
  });
};

export const formatDefaultLogMessage = (logMessage: {
  id?: string;
  text?: string;
  level?: string;
  timestamp?: number;
  groupId?: string;
  verbose?: boolean;
}): string | null => {
  const {
    id,
    text = '',
    level = 'info',
    timestamp = Date.now(),
    groupId,
    verbose,
  } = logMessage;
  const emoji = EMOJI_BY_LEVEL[level] || '•';
  const { fullTimestamp, timeDisplay, tooltipTimestamp } = formatTimestamp(
    new Date(timestamp),
  );

  const dataAttrs = [
    id ? `data-log-id="${encodeHtml(id)}"` : '',
    groupId ? `data-group-id="${encodeHtml(groupId)}"` : '',
    `data-full-timestamp="${encodeHtml(fullTimestamp)}"`,
  ]
    .filter(Boolean)
    .join(' ');

  const timestampContent = verbose ? `${emoji} [${timeDisplay}]` : emoji;
  const levelMarkup = verbose
    ? `<span class="level-${encodeHtml(level)}">${encodeHtml(
        level.toUpperCase().padEnd(8),
      )}</span> `
    : '';

  return `
    <div class="log-line" ${dataAttrs}>
      <span class="timestamp" title="${tooltipTimestamp}">${timestampContent}</span>
      ${levelMarkup}
      <span class="message-${encodeHtml(level)}">${encodeHtml(text)}</span>
    </div>
  `;
};

export const formatPlainMessage = (
  normalizedPayload: { decodedText?: string },
  logId: string,
  groupId: string | undefined,
  timestamp?: number,
): string => {
  const content = normalizedPayload.decodedText || '';
  return wrapInPre(content);
};
