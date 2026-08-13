/** XML/HTML escaping helpers. Single source of truth for both agent-core
 *  XML emission (e.g. <subagent-result> wrappers) and frontend HTML
 *  interpolation (e.g. processMarkdownContent's LaTeX reference labels).
 *  Co-located in @shared/utils so both sides import the same function. */

/** Escape for use inside a double-quoted HTML/XML attribute value. */
export function escapeAttr(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');
}

/** Escape XML/HTML text content (element bodies). */
export function escapeText(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
}

/**
 * Escape XML special chars including `>`. Use when emitting text into
 * contexts where `]]>` would terminate a CDATA section, or any other
 * place a downstream consumer might mis-parse a literal `>`.
 */
export function escapeTextStrict(s: string): string {
  return escapeText(s).replaceAll('>', '&gt;');
}

/**
 * Escape for arbitrary HTML interpolation — safe in text nodes and inside
 * single- or double-quoted attribute values (escapes `&`, `<`, `>`, `"`, `'`).
 */
export function escapeHtml(s: string): string {
  return escapeTextStrict(s).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
