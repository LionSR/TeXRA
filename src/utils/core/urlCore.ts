/**
 * URL utilities - pure URL helper functions.
 */

/**
 * Normalize a URL-like string by removing any protocol prefix and trailing slashes.
 * Preserves any path component provided.
 * @param input Raw URL or host string
 * @returns Normalized string without protocol and trailing slashes
 */
export function normalizeUrl(input: string): string {
  if (!input) {
    return '';
  }
  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    const withoutProtocol = `${url.host}${url.pathname}`;
    return withoutProtocol.replace(/\/+$/, '');
  } catch (_err) {
    return input.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}
