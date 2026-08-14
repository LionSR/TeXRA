import { summarizeEmbeddedSubagentFollowups } from '@shared/subagentFollowup';
import { protectLatexMathSpans } from '@shared/markdown/createMarkdownProcessor';
import { clamp } from '@utils/core';

const KNOWN_HTML_TAG_RE =
  /<\/?(?:blockquote|strong|b|em|i|code|p|div|br|h[1-6])(?=[\s/>])/i;
const CURRENCY_AMOUNT = String.raw`[+-]?(?:\d+(?:\.\d+)?|\.\d+)`;
const SHELL_BRACED_PARAMETER = String.raw`\{[^{}\n$]+\}`;
const SHELL_UNWRAPPED_PARAMETER = String.raw`(?:[A-Z_][A-Z0-9_]+|${SHELL_BRACED_PARAMETER}|[_?@*#!-])`;
const SHELL_PARAMETER_BOUNDARY = String.raw`(?=[\s.,;:!?()[\]{}'"’”]|$)`;
const CURRENCY_BOUNDARY = String.raw`(?=[\s.,;:!?()[\]{}'"’”]|<\/[A-Za-z]|$)`;

// Formatting tags may carry ordinary name/value attributes or standard HTML
// attributes whose value may be omitted. Arbitrary bare words (for example
// `<p and y>`) are not accepted because they are otherwise indistinguishable
// from mathematical prose and would be removed from the transcript.
const HTML_VALUELESS_ATTRIBUTE = String.raw`(?:allowfullscreen|async|autofocus|autoplay|checked|contenteditable|controls|default|defer|disabled|formnovalidate|hidden|inert|ismap|itemscope|loop|multiple|muted|nomodule|novalidate|open|playsinline|popover|readonly|required|reversed|selected)`;
const HTML_ATTRIBUTE = String.raw`(?:[A-Za-z_:][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>]+)|${HTML_VALUELESS_ATTRIBUTE})`;
const HTML_ATTRIBUTES = String.raw`(?:\s+${HTML_ATTRIBUTE})*`;
const HTML_TAG_END = String.raw`(?:\s*\/\s*|\s*)>`;
const HTML_CODE_ELEMENT_RE = new RegExp(
  `<code${HTML_ATTRIBUTES}\\s*>[\\s\\S]*?<\\/code>`,
  'giu',
);
const MARKDOWN_CODE_SPAN_RE = /(?<!`)(`+)(?!`)[\s\S]*?\1(?!`)/gu;
const CURRENCY_PAIR_RE = new RegExp(
  `\\$${CURRENCY_AMOUNT}[^\\n$]*?(?:\\s|\\s[([{"'‘“+–—-]|\\s[A-Z]{1,3})\\$${CURRENCY_AMOUNT}`,
  'gu',
);
const PUNCTUATED_CURRENCY_TOKEN_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:[A-Z]{1,3})?\\$${CURRENCY_AMOUNT}(?=[,.;:!?)](?:\\s|$))`,
  'gu',
);
const CURRENCY_BEFORE_CLOSING_TAG_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:[A-Z]{1,3})?\\$${CURRENCY_AMOUNT}(?=<\\/(?:blockquote|strong|b|em|i|code|p|div|h[1-6])\\s*>)`,
  'giu',
);
const CURRENCY_TOKEN_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:[A-Z]{1,3})?\\$${CURRENCY_AMOUNT}${CURRENCY_BOUNDARY}`,
  'gu',
);
const SHELL_UNWRAPPED_PAIR_RE = new RegExp(
  `(?<![A-Za-z0-9_}>])\\$${SHELL_UNWRAPPED_PARAMETER}${SHELL_PARAMETER_BOUNDARY}[^\\n$]*?\\$${SHELL_UNWRAPPED_PARAMETER}${SHELL_PARAMETER_BOUNDARY}`,
  'gu',
);
const SHELL_BEFORE_CLOSING_TAG_RE = new RegExp(
  `(?<![A-Za-z0-9_}])\\$${SHELL_UNWRAPPED_PARAMETER}(?=<\\/(?:blockquote|strong|b|em|i|code|p|div|h[1-6])\\s*>)`,
  'giu',
);
const SHELL_UNWRAPPED_TOKEN_RE = new RegExp(
  `(?<![A-Za-z0-9_}>])\\$${SHELL_UNWRAPPED_PARAMETER}${SHELL_PARAMETER_BOUNDARY}`,
  'gu',
);
const UNAMBIGUOUS_PRESENTATION_TAG_RE = new RegExp(
  `(?:<(?:blockquote|strong|em|code|div|h[1-6])${HTML_ATTRIBUTES}${HTML_TAG_END}|<\\/(?:blockquote|strong|em|code|div|h[1-6])\\s*>)`,
  'iu',
);
const AMBIGUOUS_PRESENTATION_OPEN_AT_END_RE = new RegExp(
  `<(b|i|p)${HTML_ATTRIBUTES}\\s*>\\s*$`,
  'iu',
);
const HEADING_TAG_RE = new RegExp(
  `<h([1-6])${HTML_ATTRIBUTES}${HTML_TAG_END}([\\s\\S]*?)<\\/h\\1>`,
  'gi',
);
const PARAGRAPH_OPEN_TAG_RE = new RegExp(
  `<(?:p|div)${HTML_ATTRIBUTES}${HTML_TAG_END}`,
  'gi',
);
const STRONG_OPEN_TAG_RE = new RegExp(
  `<(?:strong|b)${HTML_ATTRIBUTES}${HTML_TAG_END}`,
  'gi',
);
const EMPHASIS_OPEN_TAG_RE = new RegExp(
  `<(?:em|i)${HTML_ATTRIBUTES}${HTML_TAG_END}`,
  'gi',
);
const CODE_OPEN_TAG_RE = new RegExp(
  `<code${HTML_ATTRIBUTES}${HTML_TAG_END}`,
  'gi',
);
const BLOCKQUOTE_TAG_RE = new RegExp(
  `<blockquote${HTML_ATTRIBUTES}${HTML_TAG_END}([\\s\\S]*?)<\\/blockquote>`,
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

function hasPresentationHtmlBeforeNextDollar(
  source: string,
  offset: number,
  matchLength: number,
): boolean {
  const start = offset + matchLength;
  const nextDollar = source.indexOf('$', start);
  // Two later dollar delimiters supply the candidate math span that this
  // literal token must not absorb. Bare one-letter tags remain deliberately
  // ambiguous, but a matched wrapper pair is presentation markup.
  if (nextDollar < 0) return false;
  const between = source.slice(start, nextDollar);
  if (UNAMBIGUOUS_PRESENTATION_TAG_RE.test(between)) return true;
  const closingDollar = source.indexOf('$', nextDollar + 1);
  if (closingDollar < 0) return false;
  const ambiguousOpen = AMBIGUOUS_PRESENTATION_OPEN_AT_END_RE.exec(between);
  return (
    ambiguousOpen?.[1] !== undefined &&
    new RegExp(`^\\s*<\\/${ambiguousOpen[1]}\\s*>`, 'iu').test(
      source.slice(closingDollar + 1),
    )
  );
}

function shouldMaskPunctuatedCurrency(
  source: string,
  offset: number,
  matchLength: number,
): boolean {
  const start = offset + matchLength;
  const nextDollar = source.indexOf('$', start);
  if (nextDollar < 0) return true;
  const between = source.slice(start, nextDollar);
  if (UNAMBIGUOUS_PRESENTATION_TAG_RE.test(between)) return true;
  const closingDollar = source.indexOf('$', nextDollar + 1);
  return closingDollar >= 0 && /\S/u.test(source[nextDollar + 1] ?? '');
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
  const withoutCodeOrPairedTokenDollars = [
    HTML_CODE_ELEMENT_RE,
    MARKDOWN_CODE_SPAN_RE,
    CURRENCY_PAIR_RE,
    CURRENCY_BEFORE_CLOSING_TAG_RE,
    SHELL_UNWRAPPED_PAIR_RE,
    SHELL_BEFORE_CLOSING_TAG_RE,
  ].reduce(
    (value, pattern) => value.replaceAll(pattern, protectDollars),
    content,
  );
  const punctuatedCurrencyProtected =
    withoutCodeOrPairedTokenDollars.replaceAll(
      PUNCTUATED_CURRENCY_TOKEN_RE,
      (match, offset: number, source: string) =>
        shouldMaskPunctuatedCurrency(source, offset, match.length)
          ? protectDollars(match)
          : match,
    );
  const protectBeforeLaterMath = (value: string, pattern: RegExp): string =>
    value.replaceAll(pattern, (match, offset: number, source: string) =>
      hasPresentationHtmlBeforeNextDollar(source, offset, match.length)
        ? protectDollars(match)
        : match,
    );
  const contextProtected = [CURRENCY_TOKEN_RE, SHELL_UNWRAPPED_TOKEN_RE].reduce(
    protectBeforeLaterMath,
    punctuatedCurrencyProtected,
  );
  return {
    content: contextProtected,
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
