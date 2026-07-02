/**
 * Response-text preprocessing for fallback output extraction.
 *
 * Strips the model's thinking-tag XML blocks from a raw response and
 * normalizes the remainder into lines, so the header/fence recovery
 * heuristics only ever see candidate document text.
 */

import escapeRegExp from 'escape-string-regexp';

function stripXmlTagBlocks(content: string, tagName: string): string {
  const trimmedTag = tagName.trim();
  if (!trimmedTag) {
    return content;
  }
  return content.replaceAll(
    new RegExp(
      `<${escapeRegExp(trimmedTag)}\\b[^>]*>[\\s\\S]*?<\\/${escapeRegExp(trimmedTag)}>`,
      'gi',
    ),
    '',
  );
}

/** Strip `thinkingTag` blocks, normalize CRLF/CR to LF, and split into lines. */
export function responseLines(content: string, thinkingTag: string): string[] {
  return stripXmlTagBlocks(content, thinkingTag)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n');
}
