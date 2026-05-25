/**
 * Main entry point for progress view formatters.
 * Provides log message formatting functions for the progress view.
 */

// Local imports - formatter helpers
import type { LogMessageData, MessageType } from '@shared/schemas';
import { isPlainObject } from '@shared/utils/string';
import { safeFormat, type FormatOptions } from './baseLogFormatter';
import {
  formatBannerContentTemplate,
  formatContextManagementTemplate,
  formatDefaultLogMessageTemplate,
  formatErrorTemplate,
  formatFileListTemplate,
  formatLatexdiffTemplate,
  formatMissingOutputsTemplate,
  formatModelResponseTemplate,
  formatProgressStatusTemplate,
  formatStatisticsTemplate,
  formatToolUseTemplate,
  formatUserMessageTemplate,
  formatWebFetchTemplate,
  formatWebSearchTemplate,
} from './logFormatters';

// Local imports - Lit template utilities
import { html, type TemplateResult, type FormatResult } from './litTemplates';

// Local imports - shared schemas

type TemplateFormatterFn = (
  message: LogMessageData,
  options?: { defaultOpen?: boolean },
) => FormatResult;

/** Message types that auto-expand when defaultOpen is set. */
const AUTO_EXPANDED_TYPES: Set<MessageType> = new Set([
  'thinking',
  'scratchpad',
]);

/** Message types that return empty template when formatter produces no result. */
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
  return html`<div class="log-line log-line--render-error"><span class="render-error-icon">⚠️</span><span class="render-error-text">Failed to render ${label}: ${errorMsg}</span></div>`;
}

/** Wrap a formatter function with error handling for graceful degradation. */
function wrapWithErrorHandling(
  fn: (m: LogMessageData, opts?: { defaultOpen?: boolean }) => FormatResult,
  label: string,
): TemplateFormatterFn {
  return (message, options) => {
    const result = safeFormat(() => fn(message, options), label);
    if (!result.ok) {
      return formatRenderError(label, result.error);
    }
    return result.value;
  };
}

/** Name the tool in formatter errors so a bad card is actionable. */
function getToolUseRenderLabel(message: LogMessageData): string {
  const data = message.data;
  if (!isPlainObject(data)) return 'tool use';
  const toolName =
    typeof data.toolName === 'string'
      ? data.toolName
      : typeof data.tool === 'string'
        ? data.tool
        : '';
  return toolName.trim() ? `tool use (${toolName.trim()})` : 'tool use';
}

/** Map of message types to their formatter functions. */
const TEMPLATE_FORMATTERS: Record<string, TemplateFormatterFn | null> = {
  // Collapsible content banners
  thinking: wrapWithErrorHandling(formatBannerContentTemplate, 'thinking'),
  scratchpad: wrapWithErrorHandling(formatBannerContentTemplate, 'scratchpad'),

  // Tool/search/fetch results
  toolUse: (message, options) => {
    const label = getToolUseRenderLabel(message);
    const result = safeFormat(
      () => formatToolUseTemplate(message, options),
      label,
    );
    if (!result.ok) {
      return formatRenderError(label, result.error);
    }
    return result.value;
  },
  webSearch: wrapWithErrorHandling(formatWebSearchTemplate, 'web search'),
  webFetch: wrapWithErrorHandling(formatWebFetchTemplate, 'web fetch'),

  // Model response
  modelResponse: wrapWithErrorHandling(
    formatModelResponseTemplate,
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

  // Special cases
  contextState: () => null, // Displayed in footer
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
): TemplateResult {
  const { messageType } = logMessage;

  // Determine if details should be open (undefined = no preference)
  const isOpen =
    options.preservedOpen ??
    (options.defaultOpen && messageType && AUTO_EXPANDED_TYPES.has(messageType)
      ? true
      : undefined);
  const templateOptions = { defaultOpen: isOpen };

  const formatter = messageType ? TEMPLATE_FORMATTERS[messageType] : null;

  if (messageType && typeof formatter === 'function') {
    const result = formatter(logMessage, templateOptions);
    if (result) return result;
    if (NULLABLE_TYPES.has(messageType)) return html``;
  }

  return formatDefaultLogMessageTemplate(logMessage) ?? html``;
}
