// Constants
export const BULLET_MARKUP =
  '<i class="codicon codicon-circle-small-filled group-bullet"></i>';

/**
 * Format token counts, displaying values in "k" units when exceeding 4096.
 * @param {number} tokens - Raw token count
 * @returns {string} Formatted token count
 */
export function formatTokens(tokens) {
  return tokens > 4096 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
}

// Note: All other formatting functions have been moved to DOM handler classes in domHandlers.js
// - LogEntryFormatter: handles log entry formatting with markdown support
// - TaskGroupHeaderFormatter: handles group header creation and formatting
// - MessageTimestampExtractor: handles timestamp extraction from messages
