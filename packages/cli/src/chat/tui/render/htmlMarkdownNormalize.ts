import { summarizeEmbeddedSubagentFollowups } from '@shared/subagentFollowup';
import { protectLatexMathSpans } from '@shared/markdown/createMarkdownProcessor';
import { clamp } from '@utils/core';

const KNOWN_HTML_TAG_RE =
  /<\/?(?:blockquote|strong|b|em|i|code|p|div|br|h[1-6])(?=[\s/>])/i;
const CURRENCY_AMOUNT = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
const SHELL_PARAMETER_NAME = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?@*#!-])`;
const SHELL_BRACED_PARAMETER = String.raw`\{${SHELL_PARAMETER_NAME}(?:(?::?[-+=?])[^}\n]*)?\}`;
const SHELL_UNWRAPPED_PARAMETER = String.raw`(?:[A-Z_][A-Z0-9_]+|${SHELL_BRACED_PARAMETER}|[_?@*#!-])`;
const SHELL_PARAMETER_BOUNDARY = String.raw`(?=[\s.,;:!?()[\]{}'"’”]|$)`;
const CURRENCY_BOUNDARY = String.raw`(?=[\s.,;:!?()[\]{}'"’”]|<\/[A-Za-z]|$)`;

// Formatting tags may carry ordinary name/value attributes or standard HTML
// attributes whose value may be omitted. Arbitrary bare words (for example
// `<p and y>`) are not accepted because they are otherwise indistinguishable
// from mathematical prose and would be removed from the transcript.
const HTML_VALUELESS_ATTRIBUTE = String.raw`(?:allowfullscreen|async|autofocus|autoplay|checked|contenteditable|controls|default|defer|disabled|formnovalidate|hidden|inert|ismap|itemscope|loop|multiple|muted|nomodule|novalidate|open|playsinline|popover|readonly|required|reversed|selected)`;
const HTML_ATTRIBUTE = String.raw`(?:[A-Za-z_:][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>]+)|${HTML_VALUELESS_ATTRIBUTE})`;
const HTML_ATTRIBUTES = String.raw`(?:\s+${HTML_ATTRIBUTE})*\s*`;
const HTML_CODE_ELEMENT_RE = new RegExp(
  `<code${HTML_ATTRIBUTES}>[\\s\\S]*?<\\/code>`,
  'giu',
);
const MARKDOWN_CODE_SPAN_RE = /`[^`\n]*`/gu;
const CURRENCY_PAIR_RE = new RegExp(
  `\\$${CURRENCY_AMOUNT}[^\\n$]*?(?:\\s|\\s[([{"'‘“+–—-]|\\s[A-Z]{1,3})\\$${CURRENCY_AMOUNT}`,
  'gu',
);
const CURRENCY_BEFORE_MATH_RE = new RegExp(
  `(?<![A-Za-z0-9_])(?:[A-Z]{1,3})?\\$${CURRENCY_AMOUNT}${CURRENCY_BOUNDARY}(?=[^\\n$]*\\$[^\\n$]*\\$)`,
  'gu',
);
const SHELL_UNWRAPPED_TOKEN_RE = new RegExp(
  `(?<![A-Za-z0-9_}>])\\$${SHELL_UNWRAPPED_PARAMETER}${SHELL_PARAMETER_BOUNDARY}`,
  'gu',
);
const KNOWN_HTML_OPEN_TAG_RE =
  /<(blockquote|strong|b|em|i|code|p|div|br|h[1-6])(?=[\s/>])[^>]*>/giu;
const HEADING_TAG_RE = new RegExp(
  `<h([1-6])${HTML_ATTRIBUTES}\\/?\\s*>([\\s\\S]*?)<\\/h\\1>`,
  'gi',
);
const PARAGRAPH_OPEN_TAG_RE = new RegExp(
  `<(?:p|div)${HTML_ATTRIBUTES}\\/?\\s*>`,
  'gi',
);
const STRONG_OPEN_TAG_RE = new RegExp(
  `<(?:strong|b)${HTML_ATTRIBUTES}\\/?\\s*>`,
  'gi',
);
const EMPHASIS_OPEN_TAG_RE = new RegExp(
  `<(?:em|i)${HTML_ATTRIBUTES}\\/?\\s*>`,
  'gi',
);
const CODE_OPEN_TAG_RE = new RegExp(`<code${HTML_ATTRIBUTES}\\/?\\s*>`, 'gi');
const BLOCKQUOTE_TAG_RE = new RegExp(
  `<blockquote${HTML_ATTRIBUTES}\\/?\\s*>([\\s\\S]*?)<\\/blockquote>`,
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

function hasUnclosedKnownHtmlTag(content: string): boolean {
  for (const match of content.matchAll(KNOWN_HTML_OPEN_TAG_RE)) {
    const [openTag, tagName] = match;
    if (openTag.endsWith('/>')) continue;
    if (tagName?.toLowerCase() === 'br') return true;
    const remainder = content.slice((match.index ?? 0) + openTag.length);
    if (!new RegExp(`<\\/${tagName}\\s*>`, 'iu').test(remainder)) return true;
  }
  return false;
}

// CLI presentation owns currency and shell syntax. Mask only their dollar
// tokens before shared math recognition so a shell token cannot pair with a
// later formula delimiter and cause that formula's HTML-shaped TeX to leak.
function protectLiteralDollarTokens(content: string): {
  content: string;
  restore: (value: string) => string;
} {
  const items: string[] = [];
  let placeholderPrefix = '@@CLI-LITERAL-DOLLAR-';
  while (content.includes(placeholderPrefix)) placeholderPrefix += '@';
  const placeholderPattern = new RegExp(`${placeholderPrefix}(\\d+)@@`, 'g');
  const protectDollars = (match: string): string =>
    match.replaceAll(/\$\$?/g, (dollars) => {
      const index = items.push(dollars) - 1;
      return `${placeholderPrefix}${index}@@`;
    });
  const withoutCodeOrCurrencyDollars = [
    HTML_CODE_ELEMENT_RE,
    MARKDOWN_CODE_SPAN_RE,
    CURRENCY_PAIR_RE,
    CURRENCY_BEFORE_MATH_RE,
  ].reduce(
    (value, pattern) => value.replaceAll(pattern, protectDollars),
    content,
  );
  const protectedContent = withoutCodeOrCurrencyDollars.replaceAll(
    SHELL_UNWRAPPED_TOKEN_RE,
    (match, offset: number, source: string) => {
      const nextDollar = source.indexOf('$', offset + match.length);
      const followingSpan =
        nextDollar < 0 ? '' : source.slice(offset + match.length, nextDollar);
      return hasUnclosedKnownHtmlTag(followingSpan)
        ? match
        : protectDollars(match);
    },
  );
  return {
    content: protectedContent,
    restore: (value) =>
      value.replaceAll(
        placeholderPattern,
        (match, rawIndex) => items[Number(rawIndex)] ?? match,
      ),
  };
}

export function normalizeKnownHtmlForCliMarkdown(content: string): string {
  const summarized = summarizeEmbeddedSubagentFollowups(content);
  if (!KNOWN_HTML_TAG_RE.test(summarized)) return summarized;

  const literalDollarProtection = protectLiteralDollarTokens(summarized);
  const mathProtection = protectLatexMathSpans(literalDollarProtection.content);
  const mathProtected = literalDollarProtection.restore(mathProtection.content);
  if (!KNOWN_HTML_TAG_RE.test(mathProtected)) return summarized;

  const normalized = mathProtected
    .replaceAll(
      HEADING_TAG_RE,
      (_match, level: string, body: string) =>
        `\n\n${headingMarker(level)} ${body.trim()}\n\n`,
    )
    .replaceAll(/<br\s*\/?\s*>/gi, '\n')
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
  return literalDollarProtection.restore(mathProtection.restore(normalized));
}
