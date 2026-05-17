/** Normalize CRLF line endings to LF. */
export function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function objectToLogString(
  obj: unknown,
  maxLength: number = 1000,
): string {
  try {
    const json = JSON.stringify(obj);
    return json.length > maxLength
      ? `${json.substring(0, maxLength)}... (${json.length} chars)`
      : json;
  } catch (_err) {
    return String(obj);
  }
}

/**
 * Normalize line endings and split into content lines.
 * A trailing newline does not produce a phantom empty element.
 *
 * @example
 * splitContentLines('a\nb\nc')   // ['a', 'b', 'c']
 * splitContentLines('a\nb\nc\n') // ['a', 'b', 'c']
 * splitContentLines('')          // []
 */
export function splitContentLines(text: string): string[] {
  if (!text) return [];
  const lines = normalizeLineEndings(text).split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Count the number of lines in a string.
 * Handles both Unix (\n) and Windows (\r\n) line endings.
 * A trailing newline does not count as an extra line.
 *
 * @example
 * countLines('a\nb\nc') // 3
 * countLines('a\nb\nc\n') // 3 (trailing newline ignored)
 * countLines('') // 0
 */
export function countLines(text: string): number {
  return splitContentLines(text).length;
}

/**
 * Truncate a string to `maxLen` characters with a trailing ellipsis (`…`).
 * Returns the original string unchanged if it fits within the limit.
 *
 * The ellipsis is a single Unicode character (U+2026), so the truncated
 * result is exactly `maxLen` characters long.
 *
 * @example
 * truncateWithEllipsis('short', 60)           // 'short'
 * truncateWithEllipsis('a very long text', 10) // 'a very lo…'
 */
export function truncateWithEllipsis(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

/**
 * Collapse every whitespace run (including newlines) to a single space
 * and trim. Used by header-preview renderers that need a one-line summary
 * of multi-line content.
 *
 * @example
 * collapseWhitespace('foo\n  bar\t baz ') // 'foo bar baz'
 */
export function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}
