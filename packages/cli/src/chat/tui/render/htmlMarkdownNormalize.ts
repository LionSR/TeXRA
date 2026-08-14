import { summarizeEmbeddedSubagentFollowups } from '@shared/subagentFollowup';
import { protectLatexMathSpans } from '@shared/markdown/createMarkdownProcessor';
import { clamp } from '@utils/core';

const KNOWN_HTML_TAG_RE =
  /<\/?(?:blockquote|strong|b|em|i|code|p|div|br|h[1-6])(?=[\s/>])/i;
const CURRENCY_AMOUNT = String.raw`[+-]?(?:\d|\.\d)`;
const SHELL_PARAMETER_NAME = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?@*#!-])`;
const SHELL_BRACED_PARAMETER = String.raw`\{${SHELL_PARAMETER_NAME}(?:(?::?[-+=?])[^}\n]*)?\}`;
const SHELL_PARAMETER = String.raw`(?:${SHELL_PARAMETER_NAME}|${SHELL_BRACED_PARAMETER})`;
const SHELL_UNWRAPPED_PARAMETER = String.raw`(?:[A-Z_][A-Z0-9_]+|${SHELL_BRACED_PARAMETER}|[_?@*#!-])`;
const SHELL_PARAMETER_BOUNDARY = String.raw`(?=[\s.,;:!?()[\]{}'"’”]|$)`;
const SHELL_TOKEN = String.raw`(?:\$\$|\$${SHELL_PARAMETER})`;

// Formatting tags may carry ordinary name/value attributes or standard HTML
// attributes whose value may be omitted. Arbitrary bare words (for example
// `<p and y>`) are not accepted because they are otherwise indistinguishable
// from mathematical prose and would be removed from the transcript.
const HTML_VALUELESS_ATTRIBUTE = String.raw`(?:allowfullscreen|async|autofocus|autoplay|checked|contenteditable|controls|default|defer|disabled|formnovalidate|hidden|inert|ismap|itemscope|loop|multiple|muted|nomodule|novalidate|open|playsinline|popover|readonly|required|reversed|selected)`;
const HTML_ATTRIBUTE = String.raw`(?:[A-Za-z_:][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>]+)|${HTML_VALUELESS_ATTRIBUTE})`;
const HTML_ATTRIBUTES = String.raw`(?:\s+${HTML_ATTRIBUTE})*\s*`;
const HTML_CODE_SHELL_TOKEN_RE = new RegExp(
  `<code${HTML_ATTRIBUTES}>${SHELL_TOKEN}<\\/code>`,
  'giu',
);
const MARKDOWN_CODE_SHELL_TOKEN_RE = new RegExp(`\`${SHELL_TOKEN}\``, 'gu');
const CURRENCY_PAIR_RE = new RegExp(
  `\\$${CURRENCY_AMOUNT}[^\\n$]*?(?:\\s|\\s[([{"'‘“+–—-]|\\s[A-Z]{1,3})\\$${CURRENCY_AMOUNT}`,
  'gu',
);
const SHELL_UNWRAPPED_TOKEN_RE = new RegExp(
  `(?<![A-Za-z0-9_}>])\\$${SHELL_UNWRAPPED_PARAMETER}${SHELL_PARAMETER_BOUNDARY}`,
  'gu',
);
const LITERAL_DOLLAR_PLACEHOLDER_RE = /@@CLI-LITERAL-DOLLAR-(\d+)@@/g;
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

// CLI presentation owns currency and shell syntax. Mask only their dollar
// tokens before shared math recognition so a shell token cannot pair with a
// later formula delimiter and cause that formula's HTML-shaped TeX to leak.
function protectLiteralDollarTokens(content: string): {
  content: string;
  restore: (value: string) => string;
} {
  const items: string[] = [];
  const protectDollars = (match: string): string =>
    match.replaceAll(/\$\$?/g, (dollars) => {
      const index = items.push(dollars) - 1;
      return `@@CLI-LITERAL-DOLLAR-${index}@@`;
    });
  const protectedContent = [
    HTML_CODE_SHELL_TOKEN_RE,
    MARKDOWN_CODE_SHELL_TOKEN_RE,
    CURRENCY_PAIR_RE,
    SHELL_UNWRAPPED_TOKEN_RE,
  ].reduce(
    (value, pattern) => value.replaceAll(pattern, protectDollars),
    content,
  );
  return {
    content: protectedContent,
    restore: (value) =>
      value.replaceAll(
        LITERAL_DOLLAR_PLACEHOLDER_RE,
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
