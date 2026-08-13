import { summarizeEmbeddedSubagentFollowups } from '@shared/subagentFollowup';
import { clamp } from '@utils/core';

const KNOWN_HTML_TAG_RE =
  /<\/?(?:blockquote|strong|b|em|i|code|p|div|br|h[1-6])\b/i;

function quoteHtmlBlock(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') return '';
  return trimmed
    .split(/\r?\n/)
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
}

function headingMarker(level: string): string {
  const parsed = Number.parseInt(level, 10);
  const depth = Number.isFinite(parsed) ? clamp(parsed, 1, 6) : 3;
  return '#'.repeat(depth);
}

export function normalizeKnownHtmlForCliMarkdown(content: string): string {
  const summarized = summarizeEmbeddedSubagentFollowups(content);
  if (!KNOWN_HTML_TAG_RE.test(summarized)) return summarized;

  return summarized
    .replaceAll(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_match, level: string, body: string) =>
        `\n\n${headingMarker(level)} ${body.trim()}\n\n`,
    )
    .replaceAll(/<br\s*\/?>/gi, '\n')
    .replaceAll(/<\/(?:p|div)>/gi, '\n\n')
    .replaceAll(/<(?:p|div)\b[^>]*>/gi, '')
    .replaceAll(/<(?:strong|b)\b[^>]*>/gi, '**')
    .replaceAll(/<\/(?:strong|b)>/gi, '**')
    .replaceAll(/<(?:em|i)\b[^>]*>/gi, '_')
    .replaceAll(/<\/(?:em|i)>/gi, '_')
    .replaceAll(/<code\b[^>]*>/gi, '`')
    .replaceAll(/<\/code>/gi, '`')
    .replaceAll(
      /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
      (_match, body: string) => quoteHtmlBlock(body),
    )
    .trim();
}
