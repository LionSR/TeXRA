import { tryParseUrl } from '@utils/core';

/** Normalize a URL-like endpoint to `host/path` form without protocol or trailing slashes. */
export function normalizeProviderEndpoint(input: string): string {
  if (!input) return '';

  const withProtocol = input.includes('://') ? input : `https://${input}`;
  const parsed = tryParseUrl(withProtocol);
  if (!parsed) return input.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
}
