/**
 * Main entry point for progress view formatters.
 * Provides the LogEntryFormatter class and all exports for backward compatibility.
 */

// Re-export constants
export {
  BULLET_MARKUP,
  EMOJI_BY_LEVEL,
  QUERY_PREVIEW_MAX_LENGTH,
} from './constants.js';

// Re-export task group level (separate file to avoid circular imports)
export { TaskGroupLevel } from './taskGroupLevel.js';

// Re-export timestamp utilities
export {
  formatTokens,
  formatDuration,
  formatTimestamp,
  MessageTimestampExtractor,
} from './timestampUtils.js';

// Re-export task group formatter
export { TaskGroupHeaderFormatter } from './taskGroupFormatter.js';

// Re-export markdown renderer
export {
  getMarkdownRenderer,
  processMarkdownContent,
} from './markdownRenderer.js';

// Import formatters for composition
import { normalizeStructuredContent } from './normalizers.js';
import {
  applyOpenState,
  createBannerEntry,
  safeFormat,
  resolveOpenState,
} from './baseLogFormatter.js';
import {
  getMarkdownRenderer,
  processMarkdownContent,
} from './markdownRenderer.js';
import { EMOJI_BY_LEVEL } from './constants.js';
import { encodeHtml } from '@common/htmlEncoding.js';

// Import specialized formatters
import {
  formatBannerContent,
  formatModelResponse,
} from './logFormatters/bannerFormatters.js';
import {
  formatToolUse,
  formatWebSearch,
} from './logFormatters/toolFormatters.js';
import {
  formatFileList,
  formatMissingOutputs,
  formatLatexdiff,
  formatStatistics,
} from './logFormatters/dataFormatters.js';
import {
  formatUserMessage,
  formatProgressStatus,
  formatError,
  formatDefaultLogMessage,
} from './logFormatters/messageFormatters.js';

/**
 * Handles log entry formatting with markdown support.
 * This class composes specialized formatters for different message types.
 */
export class LogEntryFormatter {
  constructor() {
    this._initializeMarkdown();
    this._formatters = this._buildFormatterMap();
    this._autoExpandedTypes = new Set(['thinking', 'scratchpad']);
  }

  _initializeMarkdown() {
    this.md = getMarkdownRenderer();
  }

  _buildFormatterMap() {
    return {
      thinking: (message) =>
        safeFormat(
          () =>
            formatBannerContent(
              message.normalizedPayload,
              'Thinking',
              message.id,
              message.groupId,
              message.timestamp,
            ),
          'thinking',
        ),
      scratchpad: (message) =>
        safeFormat(
          () =>
            formatBannerContent(
              message.normalizedPayload,
              'Scratchpad',
              message.id,
              message.groupId,
              message.timestamp,
            ),
          'scratchpad',
        ),
      toolUse: (message) =>
        safeFormat(
          () =>
            formatToolUse(
              message.normalizedPayload,
              message.id,
              message.groupId,
              message.timestamp,
            ),
          'tool use',
        ),
      webSearch: (message) =>
        safeFormat(
          () =>
            formatWebSearch(
              message.normalizedPayload,
              message.id,
              message.groupId,
              message.timestamp,
            ),
          'web search',
        ),
      modelResponse: (message) =>
        safeFormat(
          () =>
            formatModelResponse({
              id: message.id,
              groupId: message.groupId,
              timestamp: message.timestamp,
              verbose: message.verbose,
              content: message.normalizedPayload,
              level: message.level,
            }),
          'Assistant',
        ),
      fileList: (message) =>
        safeFormat(
          () => formatFileList(message.normalizedPayload, message.id),
          'file list',
        ),
      missingOutputs: (message) =>
        safeFormat(
          () => formatMissingOutputs(message.normalizedPayload, message.id),
          'missing outputs',
        ),
      latexdiff: (message) =>
        safeFormat(
          () => formatLatexdiff(message.normalizedPayload, message.id),
          'latexdiff',
        ),
      statistics: (message) =>
        safeFormat(
          () => formatStatistics(message.normalizedPayload, message.id),
          'statistics',
        ),
      // Context state is displayed in the footer, not inline in logs
      contextState: () => null,
      userMessage: (message) =>
        safeFormat(
          () =>
            formatUserMessage(
              message.normalizedPayload,
              message.id,
              message.timestamp,
            ),
          'user message',
        ),
      progressStatus: (message) =>
        safeFormat(() => formatProgressStatus(message), 'progress status'),
      error: (message) => safeFormat(() => formatError(message), 'error'),
    };
  }

  /**
   * Format a log entry with Markdown rendering for banner content
   * @param {Object} logMessage - The log message to format
   * @param {Object} [options] - Formatting options
   * @returns {HTMLElement|null} DOM element for the log message
   */
  format(logMessage, options = {}) {
    const messageWithPayload = {
      ...logMessage,
      normalizedPayload: normalizeStructuredContent(
        logMessage.text,
        logMessage.data,
      ),
    };

    const { messageType } = messageWithPayload;

    const formatter = messageType ? this._formatters[messageType] : null;

    if (typeof formatter === 'function') {
      const result = formatter(messageWithPayload);
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

      if (
        messageType === 'thinking' ||
        messageType === 'scratchpad' ||
        messageType === 'modelResponse' ||
        messageType === 'contextState'
      ) {
        return null;
      }
    }

    // Default formatting for regular log messages
    return formatDefaultLogMessage(messageWithPayload);
  }
}

// Singleton instance
let sharedLogEntryFormatter;

export const getSharedLogEntryFormatter = () => {
  if (!sharedLogEntryFormatter) {
    sharedLogEntryFormatter = new LogEntryFormatter();
  }
  return sharedLogEntryFormatter;
};
