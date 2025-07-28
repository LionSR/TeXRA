/**
 * Helper function to truncate long output for logging
 *
 * @param text Text to truncate
 * @param maxLength Maximum length before truncation
 * @returns Truncated text if needed
 */
export function maybe_truncate(text: string, maxLength: number = 5000): string {
  if (text.length <= maxLength) {
    return text;
  }

  const truncatedText =
    text.substring(0, maxLength) +
    `\n...(truncated, ${text.length - maxLength} more characters)`;
  return truncatedText;
}
