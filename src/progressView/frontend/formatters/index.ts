/**
 * Main entry point for progress view formatters.
 * Provides the LogEntryFormatter class for log message formatting.
 */

// Local imports - formatter helpers
import {
  applyOpenState,
  safeFormat,
  resolveOpenState,
} from './baseLogFormatter';
import { getMarkdownRenderer } from './markdownRenderer';
import {
  formatBannerContent,
  formatModelResponse,
} from './logFormatters/bannerFormatters';
import { formatToolUse, formatWebSearch } from './logFormatters/toolFormatters';
import {
  formatFileList,
  formatMissingOutputs,
  formatLatexdiff,
  formatStatistics,
} from './logFormatters/dataFormatters';
import { formatContextManagement } from './logFormatters/contextManagementFormatters';
import {
  formatUserMessage,
  formatProgressStatus,
  formatError,
  formatDefaultLogMessage,
} from './logFormatters/messageFormatters';

// Local imports - shared schemas
import type { LogMessageData, MessageType } from '@shared/schemas';

type LogFormatOptions = {
  preservedOpen?: boolean;
  defaultOpen?: boolean;
};

type FormatterFn = (message: LogMessageData) => HTMLElement | null;
type FormatterMap = Record<string, FormatterFn | null | undefined>;

/**
 * Handles log entry formatting with markdown support.
 * This class composes specialized formatters for different message types.
 */
export class LogEntryFormatter {
  private md: ReturnType<typeof getMarkdownRenderer> | null = null;
  private _formatters: FormatterMap = {};
  private _autoExpandedTypes: Set<MessageType> = new Set();
  private _nullableTypes: Set<MessageType> = new Set();

  constructor() {
    this._initializeMarkdown();
    this._formatters = this._buildFormatterMap();
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

  _buildFormatterMap(): FormatterMap {
    // Wrap formatter functions with error handling for graceful degradation
    const safe =
      (fn: FormatterFn, label: string) =>
      (m: LogMessageData): HTMLElement | null =>
        safeFormat(() => fn(m), label);

    return {
      // Collapsible content banners (use text directly)
      thinking: safe(
        (m) =>
          formatBannerContent(m.text, 'Thinking', m.id, m.groupId, m.timestamp),
        'thinking',
      ),
      scratchpad: safe(
        (m) =>
          formatBannerContent(
            m.text,
            'Scratchpad',
            m.id,
            m.groupId,
            m.timestamp,
          ),
        'scratchpad',
      ),

      // Tool/search results (use data directly)
      toolUse: safe(
        (m) => formatToolUse(m.data, m.id, m.groupId, m.timestamp),
        'tool use',
      ),
      webSearch: safe(
        (m) => formatWebSearch(m.data, m.id, m.groupId, m.timestamp),
        'web search',
      ),

      // Model response (use text directly)
      modelResponse: safe(
        (m) =>
          formatModelResponse({
            id: m.id,
            groupId: m.groupId,
            timestamp: m.timestamp,
            verbose: m.verbose,
            text: m.text,
            level: m.level,
          }),
        'Assistant',
      ),

      // Data formatters (use data directly)
      fileList: safe((m) => formatFileList(m.data, m.text, m.id), 'file list'),
      missingOutputs: safe(
        (m) => formatMissingOutputs(m.data, m.id),
        'missing outputs',
      ),
      latexdiff: safe((m) => formatLatexdiff(m.data, m.id), 'latexdiff'),
      statistics: safe((m) => formatStatistics(m.data, m.id), 'statistics'),
      contextManagement: safe(
        (m) => formatContextManagement(m.data, m.id),
        'context management',
      ),

      // Special cases
      contextState: () => null, // Displayed in footer
      userMessage: safe(
        (m) => formatUserMessage(m.text, m.id, m.timestamp),
        'user message',
      ),
      progressStatus: safe(formatProgressStatus, 'progress status'),
      error: safe(formatError, 'error'),
    };
  }

  /** Format a log entry with Markdown rendering for banner content. */
  format(
    logMessage: LogMessageData,
    options: LogFormatOptions = {},
  ): HTMLElement | null {
    const { messageType } = logMessage;

    const formatter = messageType ? this._formatters[messageType] : null;

    if (messageType && typeof formatter === 'function') {
      const result = formatter(logMessage);
      if (result) {
        if (result instanceof HTMLElement) {
          const openOverride = resolveOpenState(
            messageType,
            options,
            this._autoExpandedTypes,
          );
          applyOpenState(result, openOverride);
        }
        return result;
      }

      if (this._nullableTypes.has(messageType)) {
        return null;
      }
    }

    // Default formatting for regular log messages
    return formatDefaultLogMessage(logMessage);
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
