/**
 * Main entry point for progress view formatters.
 * Provides log message formatting functions for the progress view.
 */

// Third-party imports - Lit template utilities
import { html, nothing, type TemplateResult } from 'lit';

// Local imports - formatter helpers
import type { LogMessageData, MessageType } from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { isObject } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  isStreamingTextLogMessage,
  type FormatOptions,
  type FormatResult,
} from './baseLogFormatter';
import { formatBannerContentTemplate } from './logFormatters/bannerFormatters';
import { formatCompactionActivityTemplate } from './logFormatters/compactionActivityFormatter';
import { formatContextManagementTemplate } from './logFormatters/contextManagementFormatters';
import {
  formatFileListTemplate,
  formatLatexdiffTemplate,
  formatMissingOutputsTemplate,
  formatStatisticsTemplate,
} from './logFormatters/dataFormatters';
import {
  formatDefaultLogMessageTemplate,
  formatErrorTemplate,
  formatProgressStatusTemplate,
  formatUserMessageTemplate,
} from './logFormatters/messageFormatters';
import { formatToolUseTemplate } from './logFormatters/toolFormatters';
import {
  formatWebFetchTemplate,
  formatWebSearchTemplate,
} from './logFormatters/toolFormatters/webFormatters';
import { formatWorkflowCallTemplate } from './logFormatters/workflowCallFormatter';

type TemplateFormatterFn = (
  message: LogMessageData,
  options?: FormatOptions & { isRunning?: boolean },
) => FormatResult;

/** Message types that auto-expand when defaultOpen is set. */
const AUTO_EXPANDED_TYPES: Set<MessageType> = new Set([
  'thinking',
  'scratchpad',
]);

/** Message types that render nothing when the formatter produces no result. */
const NULLABLE_TYPES: Set<MessageType> = new Set([
  'thinking',
  'scratchpad',
  'modelResponse',
  'contextState',
  'contextManagement',
]);

/** Create an error fallback template when formatting fails. */
function formatRenderError(label: string, errorMsg: string): TemplateResult {
  // prettier-ignore
  return html`<div class="log-line log-line--render-error"><span class="render-error-icon">${waIcon('triangle-exclamation')}</span><span class="render-error-text">Failed to render ${label}: ${errorMsg}</span></div>`;
}

/**
 * Wrap a formatter function with error handling for graceful degradation.
 * `label` may be a fixed string or a function deriving the label from the
 * message (e.g. naming the tool in a tool-use error card).
 */
function wrapWithErrorHandling(
  fn: TemplateFormatterFn,
  label: string | ((message: LogMessageData) => string),
): TemplateFormatterFn {
  return (message, options) => {
    const resolvedLabel = typeof label === 'function' ? label(message) : label;
    try {
      return fn(message, options);
    } catch (e) {
      console.error(`Error parsing ${resolvedLabel}:`, e);
      return formatRenderError(resolvedLabel, toErrorMessage(e));
    }
  };
}

/** Name the tool in formatter errors so a bad card is actionable. */
function getToolUseRenderLabel(message: LogMessageData): string {
  const data = message.data;
  if (!isObject(data)) return 'tool use';
  const toolName = typeof data.toolName === 'string' ? data.toolName : '';
  return toolName.trim() ? `tool use (${toolName.trim()})` : 'tool use';
}

/** Map of message types to their formatter functions. */
const TEMPLATE_FORMATTERS: Partial<Record<MessageType, TemplateFormatterFn>> = {
  // Collapsible content banners
  thinking: wrapWithErrorHandling(formatBannerContentTemplate, 'thinking'),
  scratchpad: wrapWithErrorHandling(formatBannerContentTemplate, 'scratchpad'),

  // Tool/search/fetch results
  toolUse: wrapWithErrorHandling(formatToolUseTemplate, getToolUseRenderLabel),
  webSearch: wrapWithErrorHandling(formatWebSearchTemplate, 'web search'),
  webFetch: wrapWithErrorHandling(formatWebFetchTemplate, 'web fetch'),

  // Model response
  modelResponse: wrapWithErrorHandling(
    formatBannerContentTemplate,
    'Assistant',
  ),

  // Data formatters
  fileList: wrapWithErrorHandling(formatFileListTemplate, 'file list'),
  missingOutputs: wrapWithErrorHandling(
    formatMissingOutputsTemplate,
    'missing outputs',
  ),
  latexdiff: wrapWithErrorHandling(formatLatexdiffTemplate, 'latexdiff'),
  statistics: wrapWithErrorHandling(formatStatisticsTemplate, 'statistics'),
  contextManagement: wrapWithErrorHandling(
    formatContextManagementTemplate,
    'context management',
  ),
  workflowTask: wrapWithErrorHandling(
    formatWorkflowCallTemplate,
    'workflow call',
  ),

  // Special cases
  contextState: () => null, // Displayed in footer
  contextCompactionActivity: wrapWithErrorHandling(
    formatCompactionActivityTemplate,
    'context compaction activity',
  ),
  userMessage: wrapWithErrorHandling(formatUserMessageTemplate, 'user message'),
  progressStatus: wrapWithErrorHandling(
    formatProgressStatusTemplate,
    'progress status',
  ),
  error: wrapWithErrorHandling(formatErrorTemplate, 'error'),
};

/** Format a log entry as a TemplateResult for direct Lit rendering. */
export function formatLogEntry(
  logMessage: LogMessageData,
  options: FormatOptions = {},
): TemplateResult | typeof nothing {
  const { messageType } = logMessage;

  // Determine if details should be open (undefined = no preference)
  const autoExpand =
    options.defaultOpen === true &&
    messageType !== undefined &&
    AUTO_EXPANDED_TYPES.has(messageType);
  const isOpen = options.preservedOpen ?? (autoExpand || undefined);
  // While the entry is still streaming in, skip markdown parsing (cheap
  // per-chunk repaint) but keep the same banner shell — never fall back to
  // the plain log-line template, or thinking blocks flash as generic info
  // logs until the stream finalizes (#7276).
  const templateOptions = {
    defaultOpen: isOpen,
    executionLabels: options.executionLabels,
    isRunning: isStreamingTextLogMessage(logMessage),
  };

  const formatter = messageType ? TEMPLATE_FORMATTERS[messageType] : undefined;

  if (messageType && formatter) {
    const result = formatter(logMessage, templateOptions);
    if (result) return result;
    if (NULLABLE_TYPES.has(messageType)) return nothing;
  }

  return formatDefaultLogMessageTemplate(logMessage) ?? nothing;
}
