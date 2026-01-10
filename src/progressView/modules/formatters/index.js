/**
 * Main entry point for progress view formatters.
 * Provides the LogEntryFormatter class and minimal re-exports for external use.
 */

// Re-exports for external modules (only what's actually imported externally)
export { formatTokens } from './timestampUtils.js';
export { TaskGroupHeaderFormatter } from './taskGroupFormatter.js';

// Internal imports for LogEntryFormatter
import { normalizeStructuredContent } from './normalizers.js';
import {
  applyOpenState,
  safeFormat,
  resolveOpenState,
} from './baseLogFormatter.js';
import { getMarkdownRenderer } from './markdownRenderer.js';
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
    // Message types that return null when their formatter produces no result
    this._nullableTypes = new Set([
      'thinking',
      'scratchpad',
      'modelResponse',
      'contextState',
    ]);
  }

  _initializeMarkdown() {
    this.md = getMarkdownRenderer();
  }

  _buildFormatterMap() {
    // Helper to wrap formatter functions with error handling
    const safe = (fn, label) => (m) => safeFormat(() => fn(m), label);

    // Banner formatter factory for thinking/scratchpad
    const banner = (title) => (m) =>
      formatBannerContent(
        m.normalizedPayload,
        title,
        m.id,
        m.groupId,
        m.timestamp,
      );

    // Data formatter factory for payload+id patterns
    const data = (fn) => (m) => fn(m.normalizedPayload, m.id);

    // Meta formatter factory for payload+id+groupId+timestamp patterns
    const meta = (fn) => (m) =>
      fn(m.normalizedPayload, m.id, m.groupId, m.timestamp);

    return {
      thinking: safe(banner('Thinking'), 'thinking'),
      scratchpad: safe(banner('Scratchpad'), 'scratchpad'),
      toolUse: safe(meta(formatToolUse), 'tool use'),
      webSearch: safe(meta(formatWebSearch), 'web search'),
      modelResponse: safe(
        (m) =>
          formatModelResponse({
            id: m.id,
            groupId: m.groupId,
            timestamp: m.timestamp,
            verbose: m.verbose,
            content: m.normalizedPayload,
            level: m.level,
          }),
        'Assistant',
      ),
      fileList: safe(data(formatFileList), 'file list'),
      missingOutputs: safe(data(formatMissingOutputs), 'missing outputs'),
      latexdiff: safe(data(formatLatexdiff), 'latexdiff'),
      statistics: safe(data(formatStatistics), 'statistics'),
      contextManagement: safe(
        data(formatContextManagement),
        'context management',
      ),
      contextState: () => null, // Displayed in footer, not inline
      userMessage: safe(
        (m) => formatUserMessage(m.normalizedPayload, m.id, m.timestamp),
        'user message',
      ),
      progressStatus: safe(formatProgressStatus, 'progress status'),
      error: safe(formatError, 'error'),
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

      if (this._nullableTypes.has(messageType)) {
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
