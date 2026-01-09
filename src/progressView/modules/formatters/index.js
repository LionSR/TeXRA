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
import { formatContextManagement } from './logFormatters/contextManagementFormatters.js';
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
    // Helper to wrap formatter functions with error handling
    const safe = (fn, label) => (message) => safeFormat(() => fn(message), label);

    // Common pattern extractors for cleaner formatter definitions
    const withPayloadAndMeta = (fn) => (message) =>
      fn(message.normalizedPayload, message.id, message.groupId, message.timestamp);
    const withPayloadAndId = (fn) => (message) =>
      fn(message.normalizedPayload, message.id);

    return {
      thinking: safe(
        withPayloadAndMeta((payload, id, groupId, ts) =>
          formatBannerContent(payload, 'Thinking', id, groupId, ts)),
        'thinking',
      ),
      scratchpad: safe(
        withPayloadAndMeta((payload, id, groupId, ts) =>
          formatBannerContent(payload, 'Scratchpad', id, groupId, ts)),
        'scratchpad',
      ),
      toolUse: safe(withPayloadAndMeta(formatToolUse), 'tool use'),
      webSearch: safe(withPayloadAndMeta(formatWebSearch), 'web search'),
      modelResponse: safe(
        (message) =>
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
      fileList: safe(withPayloadAndId(formatFileList), 'file list'),
      missingOutputs: safe(withPayloadAndId(formatMissingOutputs), 'missing outputs'),
      latexdiff: safe(withPayloadAndId(formatLatexdiff), 'latexdiff'),
      statistics: safe(withPayloadAndId(formatStatistics), 'statistics'),
      contextManagement: safe(withPayloadAndId(formatContextManagement), 'context management'),
      // Context state is displayed in the footer, not inline in logs
      contextState: () => null,
      userMessage: safe(
        (message) =>
          formatUserMessage(message.normalizedPayload, message.id, message.timestamp),
        'user message',
      ),
      progressStatus: safe((message) => formatProgressStatus(message), 'progress status'),
      error: safe((message) => formatError(message), 'error'),
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
