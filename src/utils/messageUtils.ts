// Utility functions for chat message handling

/**
 * Convert content array to a string for provider compatibility.
 *
 * @param content The message content (array or string)
 * @returns String representation of the content
 */
export function convertContentToString(content: any): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
  }

  return '';
}
