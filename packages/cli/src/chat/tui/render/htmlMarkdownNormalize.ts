import { summarizeEmbeddedSubagentFollowups } from '@shared/subagentFollowup';
import { protectLatexMathSpans } from '@shared/markdown/createMarkdownProcessor';
import { clamp } from '@utils/core';

const KNOWN_HTML_TAG_RE =
  /<\/?(?:blockquote|strong|b|em|i|code|p|div|br|h[1-6])(?=[\s/>])/i;
const CURRENCY_AMOUNT_START_RE = /^\d/u;
const CURRENCY_PAIR_END_RE = /(?:[\s>]|[\s>][([{"'‘“+–—-]|[\s>][A-Z]{2,3})\$$/u;
const SHELL_PID_CODE_PAIR_RE =
  /^\$\$?<\/code>[\s\S]*<code(?:\s[^<>]*)?>\$\$?$/iu;
const SHELL_PARAMETER = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*|[0-9?@*#!-])`;
const SHELL_PARAMETER_CODE_PAIR_RE = new RegExp(
  `^\\$${SHELL_PARAMETER}<\\/code>[\\s\\S]*?<code(?:\\s[^<>]*)?>\\$${SHELL_PARAMETER}<\\/code>`,
  'iu',
);

// Formatting tags may carry ordinary name/value attributes or standard HTML
// attributes whose value may be omitted. Arbitrary bare words (for example
// `<p and y>`) are not accepted because they are otherwise indistinguishable
// from mathematical prose and would be removed from the transcript.
const HTML_VALUELESS_ATTRIBUTE = String.raw`(?:allowfullscreen|async|autofocus|autoplay|checked|contenteditable|controls|default|defer|disabled|formnovalidate|hidden|inert|ismap|itemscope|loop|multiple|muted|nomodule|novalidate|open|playsinline|popover|readonly|required|reversed|selected)`;
const HTML_ATTRIBUTE = String.raw`(?:[A-Za-z_:][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>]+)|${HTML_VALUELESS_ATTRIBUTE})`;
const HTML_ATTRIBUTES = String.raw`(?:\s+${HTML_ATTRIBUTE})*\s*`;
const HEADING_TAG_RE = new RegExp(
  `<h([1-6])${HTML_ATTRIBUTES}\\/?>([\\s\\S]*?)<\\/h\\1>`,
  'gi',
);
const PARAGRAPH_OPEN_TAG_RE = new RegExp(
  `<(?:p|div)${HTML_ATTRIBUTES}\\/?>`,
  'gi',
);
const STRONG_OPEN_TAG_RE = new RegExp(
  `<(?:strong|b)${HTML_ATTRIBUTES}\\/?>`,
  'gi',
);
const EMPHASIS_OPEN_TAG_RE = new RegExp(
  `<(?:em|i)${HTML_ATTRIBUTES}\\/?>`,
  'gi',
);
const CODE_OPEN_TAG_RE = new RegExp(`<code${HTML_ATTRIBUTES}\\/?>`, 'gi');
const BLOCKQUOTE_TAG_RE = new RegExp(
  `<blockquote${HTML_ATTRIBUTES}\\/?>([\\s\\S]*?)<\\/blockquote>`,
  'gi',
);

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

function shouldProtectMathSpanDuringHtmlNormalization(
  span: string,
  offset: number,
  source: string,
): boolean {
  if (!span.startsWith('$')) return true;
  const delimiterWidth = span.startsWith('$$') ? 2 : 1;
  const isCurrencyPair =
    delimiterWidth === 1 &&
    CURRENCY_AMOUNT_START_RE.test(span.slice(1)) &&
    CURRENCY_PAIR_END_RE.test(span) &&
    CURRENCY_AMOUNT_START_RE.test(source.slice(offset + span.length));
  const isShellParameterPair = SHELL_PARAMETER_CODE_PAIR_RE.test(
    source.slice(offset),
  );
  return !(
    isCurrencyPair ||
    isShellParameterPair ||
    SHELL_PID_CODE_PAIR_RE.test(span)
  );
}

export function normalizeKnownHtmlForCliMarkdown(content: string): string {
  const summarized = summarizeEmbeddedSubagentFollowups(content);
  if (!KNOWN_HTML_TAG_RE.test(summarized)) return summarized;

  const mathProtection = protectLatexMathSpans(
    summarized,
    shouldProtectMathSpanDuringHtmlNormalization,
  );
  if (!KNOWN_HTML_TAG_RE.test(mathProtection.content)) return summarized;

  const normalized = mathProtection.content
    .replaceAll(
      HEADING_TAG_RE,
      (_match, level: string, body: string) =>
        `\n\n${headingMarker(level)} ${body.trim()}\n\n`,
    )
    .replaceAll(/<br\s*\/?>/gi, '\n')
    .replaceAll(/<\/(?:p|div)>/gi, '\n\n')
    .replaceAll(PARAGRAPH_OPEN_TAG_RE, '')
    .replaceAll(STRONG_OPEN_TAG_RE, '**')
    .replaceAll(/<\/(?:strong|b)>/gi, '**')
    .replaceAll(EMPHASIS_OPEN_TAG_RE, '_')
    .replaceAll(/<\/(?:em|i)>/gi, '_')
    .replaceAll(CODE_OPEN_TAG_RE, '`')
    .replaceAll(/<\/code>/gi, '`')
    .replaceAll(BLOCKQUOTE_TAG_RE, (_match, body: string) =>
      quoteHtmlBlock(mathProtection.restore(body)),
    )
    .trim();
  return mathProtection.restore(normalized);
}
