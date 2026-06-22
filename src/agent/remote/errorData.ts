/**
 * Convert ky's `HTTPError.data` (a parsed JSON value for JSON responses, or a
 * plain string otherwise) into a flat string for error messages, or `undefined`
 * when there is nothing useful to report.
 */
export function errorDataToString(data: unknown): string | undefined {
  if (typeof data === 'string') return data || undefined;
  if (data != null) return JSON.stringify(data);
  return undefined;
}
