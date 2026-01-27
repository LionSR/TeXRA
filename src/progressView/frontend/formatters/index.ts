/**
 * Main entry point for progress view formatters.
 * Provides the LogEntryFormatter class for log message formatting.
 */

// Local imports - formatter helpers
import { safeFormat, resolveOpenState } from './baseLogFormatter';
import { getMarkdownRenderer } from './markdownRenderer';
import {
  formatBannerContentTemplate,
  formatModelResponseTemplate,
} from './logFormatters/bannerFormatters';
import {
  formatToolUseTemplate,
  formatWebSearchTemplate,
} from './logFormatters/toolFormatters';
import {
  formatFileListTemplate,
  formatMissingOutputsTemplate,
  formatLatexdiffTemplate,
  formatStatisticsTemplate,
} from './logFormatters/dataFormatters';
import { formatContextManagementTemplate } from './logFormatters/contextManagementFormatters';
import {
  formatUserMessageTemplate,
  formatProgressStatusTemplate,
  formatErrorTemplate,
  formatDefaultLogMessageTemplate,
} from './logFormatters/messageFormatters';

// Local imports - Lit template utilities
import { html, type TemplateResult, type FormatResult } from './litTemplates';

// Local imports - shared schemas
import type { LogMessageData, MessageType } from '@shared/schemas';

type LogFormatOptions = {
  preservedOpen?: boolean;
  defaultOpen?: boolean;
};

type TemplateFormatterFn = (
  message: LogMessageData,
  options?: { defaultOpen?: boolean },
) => FormatResult;
type TemplateFormatterMap = Record<
  string,
  TemplateFormatterFn | null | undefined
>;

/**
 * Handles log entry formatting with markdown support.
 * This class composes specialized formatters for different message types.
 */
export class LogEntryFormatter {
  private md: ReturnType<typeof getMarkdownRenderer> | null = null;
  private _templateFormatters: TemplateFormatterMap = {};
  private _autoExpandedTypes: Set<MessageType> = new Set();
  private _nullableTypes: Set<MessageType> = new Set();

  constructor() {
    this._initializeMarkdown();
    this._templateFormatters = this._buildTemplateFormatterMap();
    this._autoExpandedTypes = new Set(['thinking', 'scratchpad']);
    // Message types that return null when their formatter produces no result
    this._nullableTypes = new Set([
      'thinking',
      'scratchpad',
      'modelResponse',
      'contextState',
    ]);
  }

  _initializeMarkdown(): void {
    this.md = getMarkdownRenderer();
  }

  _buildTemplateFormatterMap(): TemplateFormatterMap {
    // Wrap formatter functions with error handling for graceful degradation
    const safe =
      (
        fn: (
          m: LogMessageData,
          opts?: { defaultOpen?: boolean },
        ) => FormatResult,
        label: string,
      ): TemplateFormatterFn =>
      (m, opts): FormatResult =>
        safeFormat(() => fn(m, opts), label);

    return {
      // Collapsible content banners
      thinking: safe(formatBannerContentTemplate, 'thinking'),
      scratchpad: safe(formatBannerContentTemplate, 'scratchpad'),

      // Tool/search results
      toolUse: safe(formatToolUseTemplate, 'tool use'),
      webSearch: safe(formatWebSearchTemplate, 'web search'),

      // Model response
      modelResponse: safe(formatModelResponseTemplate, 'Assistant'),

      // Data formatters
      fileList: safe(formatFileListTemplate, 'file list'),
      missingOutputs: safe(formatMissingOutputsTemplate, 'missing outputs'),
      latexdiff: safe(formatLatexdiffTemplate, 'latexdiff'),
      statistics: safe(formatStatisticsTemplate, 'statistics'),
      contextManagement: safe(
        formatContextManagementTemplate,
        'context management',
      ),

      // Special cases
      contextState: () => null, // Displayed in footer
      userMessage: safe(formatUserMessageTemplate, 'user message'),
      progressStatus: safe(formatProgressStatusTemplate, 'progress status'),
      error: safe(formatErrorTemplate, 'error'),
    };
  }

  /** Format a log entry as a TemplateResult for direct Lit rendering. */
  formatTemplate(
    logMessage: LogMessageData,
    options: LogFormatOptions = {},
  ): TemplateResult {
    const { messageType } = logMessage;

    // Determine if details should be open
    const shouldBeOpen = resolveOpenState(
      messageType ?? '',
      options,
      this._autoExpandedTypes,
    );
    const templateOptions = { defaultOpen: shouldBeOpen ?? false };

    const formatter = messageType
      ? this._templateFormatters[messageType]
      : null;

    if (messageType && typeof formatter === 'function') {
      const result = formatter(logMessage, templateOptions);
      if (result) {
        return result;
      }

      if (this._nullableTypes.has(messageType)) {
        return html``;
      }
    }

    // Default formatting for regular log messages
    return formatDefaultLogMessageTemplate(logMessage) ?? html``;
  }
}

// Singleton instance
let sharedLogEntryFormatter: LogEntryFormatter | null = null;

export const getSharedLogEntryFormatter = (): LogEntryFormatter => {
  if (!sharedLogEntryFormatter) {
    sharedLogEntryFormatter = new LogEntryFormatter();
  }
  return sharedLogEntryFormatter;
};

export type { LogFormatOptions };
