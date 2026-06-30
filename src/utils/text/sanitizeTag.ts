/**
 * Wrap a body in `<tagName>…</tagName>` while neutralizing any literal
 * occurrences of the tag inside the body, so a payload coming from an
 * untrusted source (PR webhook fields, agent names, etc.) cannot escape
 * the wrapper and feed text to the LLM as if it were direct user input.
 *
 * Matches `</tag>` and `<tag>` liberally — whitespace inside the tag,
 * case-insensitive — because LLMs and HTML parsers both accept variants
 * like `</tag >`, `< / tag >`, etc. as closers. The replacement injects
 * a zero-width space into the tag *name* so no re-parser can reconstruct
 * it; guarding only the outside of the tag would leave the middle
 * structurally intact.
 */

import escapeRegExp from 'escape-string-regexp';

const VALID_TAG_NAME = /^[a-z][a-z0-9-]*$/i;

function sanitizeTag(tagName: string, body: string): string {
  if (!VALID_TAG_NAME.test(tagName)) {
    throw new Error(`Invalid tag name for sanitizer: ${tagName}`);
  }
  const re = new RegExp(`<\\s*/?\\s*${escapeRegExp(tagName)}\\s*>`, 'gi');
  const ZWSP = String.fromCharCode(0x200b);
  const broken = `${tagName.at(0)}${ZWSP}${tagName.slice(1)}`;
  return body.replaceAll(re, (match) =>
    match.includes('/') ? `</${broken}>` : `<${broken}>`,
  );
}

export function wrapAndSanitizeTag(tagName: string, body: string): string {
  return `<${tagName}>\n${sanitizeTag(tagName, body)}\n</${tagName}>`;
}
