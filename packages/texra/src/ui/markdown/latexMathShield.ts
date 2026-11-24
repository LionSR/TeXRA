// LaTeX math shields: the bounded inline-dollar scanner and the combined
// environment + span shield.

import {
  applyEnvironmentShields,
  findDisplayMathRanges,
  type BegEndEnvironmentProbe,
} from './begEndEnvironmentProbe';
import {
  DISPLAY_MATH_SPAN_PATTERNS,
  protectPatternsInto,
  holdPlaceholder,
  placeholderRestorer,
  selectPlaceholderTag,
} from './latexPlaceholders';

const REGEX_SPACE_RE = /\s/u;
// What ends a candidate `$…$` span for the terminal, which parses HTML: a
// tag of an element the terminal reads (math has no `<strong>`), so
// `$5 for <strong>$x$</strong>` keeps the currency outside the formula and
// `<code>` text stays literal. A one-letter element counts only when it
// closes: `$0<p>1$` is an inequality.
const NOT_MATH_TAG_RE =
  /<\/?(?:strong|em|code|div|blockquote|h[1-6])[\s/>]|<\/[bip]\s*>/giu;

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
function protectRenderInlineDollarSpans(
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
  // End offset of the first not-math tag starting at or after each offset,
  // so rejecting a candidate stays constant-time.
  const nextTagEnd = new Int32Array(content.length).fill(-1);
  for (const match of content.matchAll(NOT_MATH_TAG_RE)) {
    nextTagEnd[match.index] = match.index + match[0].length;
  }
  for (let index = content.length - 2; index >= 0; index--) {
    if (nextTagEnd[index] === -1) nextTagEnd[index] = nextTagEnd[index + 1];
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
    const closer = index + 2 < content.length ? nextValidDollar[index + 2] : -1;
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
    // `<code>$HOME</code> or <code>$PATH</code>` holds two shell variables.
    if (nextTagEnd[index] !== -1 && nextTagEnd[index] <= closer) {
      index++;
      continue;
    }

    pieces.push(content.slice(copiedUntil, index));
    pieces.push(holdPlaceholder(items, tag, content.slice(index, closer + 1)));
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
    DISPLAY_MATH_SPAN_PATTERNS,
    selectedTag,
    items,
    true,
  );
  return {
    content: protectRenderInlineDollarSpans(
      patternProtected,
      selectedTag,
      items,
    ),
    restore: placeholderRestorer(selectedTag, items),
  };
}
