import { summarizeEmbeddedSubagentFollowups } from '@shared/subagentFollowup';
import { clamp } from '@utils/core';

// Compact comparisons such as `0<p>1` are TeX, not paragraph markup.
const KNOWN_HTML_TAG_RE =
  /(?<![\p{L}\p{N}_])<\/?(?:blockquote|strong|b|em|i|code|p|div|br|h[1-6])(?=[\s/>])/iu;

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
      /(?<![\p{L}\p{N}_])<h([1-6])(?=[\s/>])[^<>]*>([\s\S]*?)<\/h\1>/giu,
      (_match, level: string, body: string) =>
        `\n\n${headingMarker(level)} ${body.trim()}\n\n`,
    )
    .replaceAll(/(?<![\p{L}\p{N}_])<br\s*\/?>/giu, '\n')
    .replaceAll(
      /(?<![\p{L}\p{N}_])<(p|div)(?=[\s/>])[^<>]*>([\s\S]*?)<\/\1>/giu,
      (_match, _tag: string, body: string) => `\n\n${body.trim()}\n\n`,
    )
    .replaceAll(
      /(?<![\p{L}\p{N}_])<(strong|b)(?=[\s/>])[^<>]*>([\s\S]*?)<\/\1>/giu,
      (_match, _tag: string, body: string) => `**${body}**`,
    )
    .replaceAll(
      /(?<![\p{L}\p{N}_])<(em|i)(?=[\s/>])[^<>]*>([\s\S]*?)<\/\1>/giu,
      (_match, _tag: string, body: string) => `_${body}_`,
    )
    .replaceAll(
      /(?<![\p{L}\p{N}_])<code(?=[\s/>])[^<>]*>([\s\S]*?)<\/code>/giu,
      (_match, body: string) => `\`${body}\``,
    )
    .replaceAll(
      /(?<![\p{L}\p{N}_])<blockquote(?=[\s/>])[^<>]*>([\s\S]*?)<\/blockquote>/giu,
      (_match, body: string) => quoteHtmlBlock(body),
    )
    .trim();
}
