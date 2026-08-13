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
 * otherwise. Unsafe values should be omitted or rendered as inert text.
 *
 * Root-relative paths are rejected, not treated as safe-as-is like an anchor
 * fragment: unlike a browser resolving against the current page's origin, a
 * standalone HTML export opens via `file://` with no origin, where a
 * tool-controlled `/etc/passwd` would resolve against the filesystem root
 * (issue #7230 follow-up).
 *
 * This function only guarantees the URL *scheme* is safe — it returns the
 * raw, unescaped input, not a value normalized for any particular embedding
 * syntax. Callers that interpolate the result into a format with its own
 * special characters (Markdown `[]()`, LaTeX `\href{}{}`) must escape it for
 * that syntax themselves; see `markdownSpec.ts`/`latexSpec.ts` for the
 * concrete escaping this repo already applies at those embedding sites.
 */
export function sanitizeLiveLinkUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (trimmed.startsWith('#')) return trimmed;
  const url = tryParseUrl(trimmed);
  if (!url) return undefined;
  return SAFE_LIVE_LINK_URL_SCHEMES.has(url.protocol) ? trimmed : undefined;
}
