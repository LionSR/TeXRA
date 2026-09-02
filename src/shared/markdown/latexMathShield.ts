// LaTeX math shields: the bounded inline-dollar scanner, the combined
// environment + span shield, and the two exported shields the HTML normalizer
// runs before rendering.

import {
  applyEnvironmentShields,
  createBegEndEnvironmentProbe,
  createProbeMarkdownIt,
  findDisplayMathRanges,
  type BegEndEnvironmentProbe,
} from './begEndEnvironmentProbe';
import {
  MATH_SPAN_PATTERNS,
  protectByPatterns,
  protectPatternsInto,
  restorePlaceholders,
  selectPlaceholderTag,
} from './latexPlaceholders';

type InlineDollarProtector = (
  content: string,
  tag: string,
  items: string[],
) => string;

const REGEX_SPACE_RE = /\s/u;

function isAsciiDigitCode(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isLineTerminatorCode(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

// Bounded linear replacement for a render-time inline-dollar regex. The
// texmath body allows interior `$`, which makes a regex backtrack over the
// rest of the line for every currency token. Precompute the next valid closer
// per offset (a `$` preceded by a non-space, non-backslash character), then
// scan openers once.
export function protectRenderInlineDollarSpans(
  content: string,
  tag: string,
  items: string[],
): string {
  const nextValidDollar = new Int32Array(content.length);
  let next = -1;
  for (let index = content.length - 1; index >= 0; index--) {
    if (isLineTerminatorCode(content.charCodeAt(index))) {
      nextValidDollar[index] = -1;
      next = -1;
      continue;
    }
    if (content[index] === '$' && index > 0) {
      const previous = content[index - 1];
      if (previous !== '\\' && !REGEX_SPACE_RE.test(previous)) {
        next = index;
        nextValidDollar[index] = index;
        continue;
      }
    }
    nextValidDollar[index] = next;
  }

  const pieces: string[] = [];
  let copiedUntil = 0;
  let matched = false;
  let index = 0;
  while (index < content.length) {
    if (content[index] !== '$') {
      index++;
      continue;
    }
    // texmath's `$_pre`: no backslash and no ASCII digit before the opener.
    if (
      index > 0 &&
      (content[index - 1] === '\\' ||
        isAsciiDigitCode(content.charCodeAt(index - 1)))
    ) {
      index++;
      continue;
    }
    if (index + 1 >= content.length) break;
    const first = content[index + 1];
    // texmath's body starts with `\S` — a backslash is allowed as the first
    // body character (e.g. `$\{…\}$`); only whitespace/line terminators are not.
    if (REGEX_SPACE_RE.test(first)) {
      index++;
      continue;
    }
    const closer =
      index + 2 < content.length ? nextValidDollar[index + 2]! : -1;
    if (closer === -1) {
      index++;
      continue;
    }
    // texmath's `$_post`: no ASCII digit after the closer (end is allowed).
    // When the first valid closer fails this guard, texmath's inline rule
    // returns false for the current opener; it does not retry a later closer.
    // Advance one character so the failed closer can be reconsidered as a new
    // opener on the next iteration.
    if (
      closer + 1 < content.length &&
      isAsciiDigitCode(content.charCodeAt(closer + 1))
    ) {
      index++;
      continue;
    }

    pieces.push(content.slice(copiedUntil, index));
    const itemIndex = items.push(content.slice(index, closer + 1)) - 1;
    pieces.push(`@@${tag}-${itemIndex}@@`);
    copiedUntil = closer + 1;
    matched = true;
    index = closer + 1;
  }

  if (!matched) return content;
  pieces.push(content.slice(copiedUntil));
  return pieces.join('');
}

export function protectLatexMathSpansWithEnvironment(
  content: string,
  environmentProbe: BegEndEnvironmentProbe,
  patterns: readonly RegExp[],
  protectInlineDollars?: InlineDollarProtector,
): {
  content: string;
  restore: (value: string) => string;
} {
  const items: string[] = [];
  const selectedTag = selectPlaceholderTag(content, 'LATEX-MATH');
  // Probe and shield environments against the pre-inline-shield content so the
  // closer search sees the same literal `\end{name}` texmath's lazy block
  // regex sees. Inline/display spans are shielded afterwards; the shared
  // fixpoint restore still resolves a `\begin{…}…\end{…}` placeholder nested
  // inside a later `$$…$$` / `\[…\]` fence.
  const matches = environmentProbe.collect(
    content,
    findDisplayMathRanges(content),
  );
  const envProtected = applyEnvironmentShields(
    content,
    matches,
    selectedTag,
    items,
  );
  const patternProtected = protectPatternsInto(
    envProtected,
    patterns,
    selectedTag,
    items,
    true,
  );
  const final = protectInlineDollars
    ? protectInlineDollars(patternProtected, selectedTag, items)
    : patternProtected;
  const placeholder = new RegExp(`@@${selectedTag}-(\\d+)@@`, 'g');
  return {
    content: final,
    restore: (value) => restorePlaceholders(value, placeholder, items),
  };
}

let normalizeEnvironmentProbe: BegEndEnvironmentProbe | undefined;

/**
 * Inline/display math shield for the HTML normalizer's first pass. It keeps
 * the lax inline `$…$` contract but leaves environments for the second,
 * structural pass so HTML block containers can be unwrapped in between.
 */
export function protectLatexMathSpansForNormalizeInline(content: string): {
  content: string;
  restore: (value: string) => string;
} {
  return protectByPatterns(content, MATH_SPAN_PATTERNS, 'LATEX-MATH', true);
}

/**
 * `htmlMarkdownNormalize`'s math shield: the lax inline `$…$` set plus the
 * container/fence-aware environment probe. The normalize pass runs before the
 * renderer, so it needs the same list-continuation/blockquote awareness or a
 * `<br>` inside `10. Formula:\n    \begin{align}` would be mutated before the
 * render shield can protect it.
 *
 * CRLF / bare CR are normalized here defensively, and the caller normalizes
 * too: the probe and `applyEnvironmentShields` must always slice the same LF
 * string markdown-it's block parser sees.
 */
export function protectLatexMathSpansForNormalize(content: string): {
  content: string;
  restore: (value: string) => string;
} {
  const source = content.replaceAll(/\r\n?/g, '\n');
  normalizeEnvironmentProbe ??= createBegEndEnvironmentProbe(
    createProbeMarkdownIt(),
  );
  return protectLatexMathSpansWithEnvironment(
    source,
    normalizeEnvironmentProbe,
    MATH_SPAN_PATTERNS,
  );
}
