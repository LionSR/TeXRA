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
