/**
 * Text manipulation utilities for progress view formatters.
 */

/**
 * Truncate text with ellipsis if it exceeds the max length.
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length before truncation
 * @returns {string} Truncated text with ellipsis, or original if within limit
 */
export function truncateWithEllipsis(text, maxLength) {
  if (!text) return '';
  return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
}
