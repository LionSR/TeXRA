/**
 * Parse a URL string, returning `undefined` instead of throwing on invalid
 * input. Centralizes the `new URL(...)` guard so callers don't each need a
 * try/catch. Browser-safe (URL is a web standard global).
 */
export function tryParseUrl(input: string, base?: string): URL | undefined {
  try {
    return new URL(input, base);
  } catch {
    return undefined;
  }
}
