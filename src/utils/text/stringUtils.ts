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
  if (!text) return 0;
  const normalized = normalizeLineEndings(text);
  const lines = normalized.split('\n');
  return normalized.endsWith('\n')
    ? Math.max(lines.length - 1, 0)
    : lines.length;
}
