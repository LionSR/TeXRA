/**
 * Main entry point for progress view formatters.
 * Provides log message formatting functions for the progress view.
 */

// Third-party imports - Lit template utilities
import { html, nothing, type TemplateResult } from 'lit';

// Local imports - formatter helpers
import {
  MESSAGE_TYPES,
  type LogMessageData,
  type LogMessageOf,
  type MessageType,
} from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';
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

type TemplateFormatterFn<T extends MessageType> = (
  message: LogMessageOf<T>,
  options?: FormatOptions & { isRunning?: boolean },
) => FormatResult;

type TemplateFormatterMap = {
  [T in MessageType]?: TemplateFormatterFn<T>;
};

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
function wrapWithErrorHandling<T extends MessageType>(
  fn: TemplateFormatterFn<T>,
  label: string | ((message: LogMessageOf<T>) => string),
): TemplateFormatterFn<T> {
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
function getToolUseRenderLabel(
  message: LogMessageOf<typeof MESSAGE_TYPES.TOOL_USE>,
): string {
  const toolName = message.data.toolName ?? '';
  return toolName.trim() ? `tool use (${toolName.trim()})` : 'tool use';
}

/** Map of message types to their formatter functions. */
const TEMPLATE_FORMATTERS: TemplateFormatterMap = {
  // Collapsible content banners
  thinking: wrapWithErrorHandling<typeof MESSAGE_TYPES.THINKING>(
    formatBannerContentTemplate,
    'thinking',
  ),
  scratchpad: wrapWithErrorHandling<typeof MESSAGE_TYPES.SCRATCHPAD>(
    formatBannerContentTemplate,
    'scratchpad',
  ),

  // Tool/search/fetch results
  toolUse: wrapWithErrorHandling(formatToolUseTemplate, getToolUseRenderLabel),
  webSearch: wrapWithErrorHandling(formatWebSearchTemplate, 'web search'),
  webFetch: wrapWithErrorHandling(formatWebFetchTemplate, 'web fetch'),

  // Model response
  modelResponse: wrapWithErrorHandling<typeof MESSAGE_TYPES.MODEL_RESPONSE>(
    formatBannerContentTemplate,
    'Assistant',
  ),

  // Data formatters
  fileList: wrapWithErrorHandling(formatFileListTemplate, 'file list'),
  missingOutputs: wrapWithErrorHandling(
    formatMissingOutputsTemplate,
    'missing outputs',
  ),
  latexdiff: wrapWithErrorHandling<typeof MESSAGE_TYPES.LATEXDIFF>(
    formatLatexdiffTemplate,
    'latexdiff',
  ),
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
  contextCompactionActivity: wrapWithErrorHandling<
    typeof MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY
  >(formatCompactionActivityTemplate, 'context compaction activity'),
  userMessage: wrapWithErrorHandling(formatUserMessageTemplate, 'user message'),
  progressStatus: wrapWithErrorHandling<typeof MESSAGE_TYPES.PROGRESS_STATUS>(
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

  // While the entry is still streaming in, skip markdown parsing (cheap
  // per-chunk repaint) but keep the same banner shell — never fall back to
  // the plain log-line template, or thinking blocks flash as generic info
  // logs until the stream finalizes (#7276).
  const templateOptions = {
    executionLabels: options.executionLabels,
    isRunning: isStreamingTextLogMessage(logMessage),
  };

  const formatter = messageType ? TEMPLATE_FORMATTERS[messageType] : undefined;

  if (messageType && formatter) {
    // Runtime lookup preserves the messageType/payload correlation encoded by
    // TemplateFormatterMap; TypeScript cannot retain that correlation through
    // an indexed access over the full MessageType union.
    const result = formatter(logMessage as never, templateOptions);
    if (result) return result;
    if (NULLABLE_TYPES.has(messageType)) return nothing;
  }

  return formatDefaultLogMessageTemplate(logMessage) ?? nothing;
}
