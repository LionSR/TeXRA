/**
 * Main entry point for progress view formatters.
 * Provides log message formatting functions for the progress view.
 */

// Local imports - formatter helpers
import {
  safeFormat,
  shouldBeOpen,
  type FormatOptions,
} from './baseLogFormatter';
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
  formatWebSearchTemplate,
} from './logFormatters';

// Local imports - Lit template utilities
import { html, type TemplateResult, type FormatResult } from './litTemplates';

// Local imports - shared schemas
import type { LogMessageData, MessageType } from '@shared/schemas';

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
]);

/** Wrap a formatter function with error handling for graceful degradation. */
function wrapWithErrorHandling(
  fn: (m: LogMessageData, opts?: { defaultOpen?: boolean }) => FormatResult,
  label: string,
): TemplateFormatterFn {
  return (message, options) => safeFormat(() => fn(message, options), label);
}

/** Map of message types to their formatter functions. */
const TEMPLATE_FORMATTERS: Record<string, TemplateFormatterFn | null> = {
  // Collapsible content banners
  thinking: wrapWithErrorHandling(formatBannerContentTemplate, 'thinking'),
  scratchpad: wrapWithErrorHandling(formatBannerContentTemplate, 'scratchpad'),

  // Tool/search results
  toolUse: wrapWithErrorHandling(formatToolUseTemplate, 'tool use'),
  webSearch: wrapWithErrorHandling(formatWebSearchTemplate, 'web search'),

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
function formatLogTemplate(
  logMessage: LogMessageData,
  options: FormatOptions = {},
): TemplateResult {
  const { messageType } = logMessage;

  // Determine if details should be open (undefined means no preference)
  const isOpen = shouldBeOpen(messageType ?? '', options, AUTO_EXPANDED_TYPES);
  const templateOptions = { defaultOpen: isOpen };

  const formatter = messageType ? TEMPLATE_FORMATTERS[messageType] : null;

  if (messageType && typeof formatter === 'function') {
    const result = formatter(logMessage, templateOptions);
    if (result) return result;
    if (NULLABLE_TYPES.has(messageType)) return html``;
  }

  return formatDefaultLogMessageTemplate(logMessage) ?? html``;
}

/**
 * LogEntryFormatter provides log entry formatting.
 * This class wraps the module-level formatting function for compatibility
 * with existing code that expects a class instance.
 */
export class LogEntryFormatter {
  formatTemplate(
    logMessage: LogMessageData,
    options: FormatOptions = {},
  ): TemplateResult {
    return formatLogTemplate(logMessage, options);
  }
}

/** Shared formatter instance for use across the progress view. */
const sharedLogEntryFormatter = new LogEntryFormatter();

export function getSharedLogEntryFormatter(): LogEntryFormatter {
  return sharedLogEntryFormatter;
}
