// Local imports - URL primitives
import { tryParseUrl } from '@utils/core';

/**
 * Schemes a tool-controlled URL may use when rendered as a live link.
 * Mirrors the retired `SAFE_URL_SCHEMES` from the hand-written HTML chat
 * exporter's `safeUrl()` helper.
 */
const SAFE_LIVE_LINK_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Returns `raw` unchanged if it is safe to render as a live link, or `undefined`
 * if it is not. Unsafe values should be omitted or rendered as inert text.
 *
 * Behavior matches the retired `safeUrl()` exactly:
 * - trims surrounding whitespace
 * - empty string -> unsafe
 * - anchor-only (`#foo`) -> safe as-is, no scheme to abuse
 * - root-relative (`/foo`, but not protocol-relative `//foo`) -> safe as-is
 * - everything else must parse as an absolute URL with an allow-listed scheme
 */
export function sanitizeLiveLinkUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (trimmed.startsWith('#')) return trimmed;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  const url = tryParseUrl(trimmed);
  if (!url) return undefined;
  return SAFE_LIVE_LINK_URL_SCHEMES.has(url.protocol) ? trimmed : undefined;
}
