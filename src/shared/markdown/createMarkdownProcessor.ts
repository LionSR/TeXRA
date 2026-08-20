// Cached markdown processor: protects LaTeX references from markdown parsing,
// applies a small pre-pass for OpenAI-style headings, renders through the
// supplied `MarkdownIt`, and memoises the output keyed by content hash.
//
// Each host (webview HTML, CLI ANSI) builds its own processor so caches stay
// isolated — the cached values are not interchangeable between renderers.

import { LRUCache } from 'lru-cache';
import MarkdownIt, { type StateBlock } from 'markdown-it';

import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';

import type { MarkdownItInstance } from './createMarkdownRenderer';

const MAX_CACHE_ENTRIES = 2000;
const MAX_CACHE_ENTRY_CHARS = 200_000;
const MAX_CACHE_TOTAL_CHARS = 2_000_000;

export interface LatexReferenceFormatter {
  /**
   * Render a `\ref{label}` / `\cref{label}` / `\eqref{label}` after the
   * markdown body has been rendered. Webview emits a clickable span; CLI
   * emits a dim ANSI underline.
   */
  (refType: string, label: string): string;
}

interface MarkdownProcessorConfig {
  readonly renderer: MarkdownItInstance;
  /**
   * Formatter for `\ref{…}` / `\cref{…}` / `\eqref{…}` placeholders. Defaults
   * to the webview-style `<span class="latex-ref clickable-link">` so existing
   * progress-view callers keep their behaviour.
   */
  readonly formatLatexReference?: LatexReferenceFormatter;
  /**
   * When true, shield LaTeX math from markdown-it so it reaches the renderer
   * verbatim. Without a math plugin, markdown-it treats the body of `$…$` /
   * `$$…$$` / `\(…\)` / `\[…\]` spans and `\begin{env}…\end{env}` environments
   * as ordinary markdown and corrupts it two ways: its CommonMark escape rule
   * strips the backslash before escapable punctuation (`\(`→`(`, `\;`→`;`,
   * `\{`→`{`, `\,`→`,`), and its emphasis rule eats `_{…}` subscripts
   * (`a_{i}b_{j}` → `a<em>i</em>b_{j}`). We protect the whole span, plus a
   * safety net for stray spacing/brace macros (`\,` `\;` `\:` `\!` `\(` `\)`
   * `\[` `\]` `\{` `\}`) outside any span.
   *
   * Enabled by the CLI host, which deliberately shows LaTeX *source* verbatim
   * (terminal math rendering is disabled). The webview / HTML-export leave this
   * off: their KaTeX/texmath pipeline consumes the math and must see it raw.
   * `\$` `\#` `\&` `\%` `\_` `\*` are never protected — they carry genuine
   * markdown-escape meaning.
   */
  readonly protectLatexMath?: boolean;
}

/**
 * Test-only telemetry returned alongside the processor. `hits` increments
 * every time the LRU returns a cached value; `misses` every time the
 * renderer runs. Tests assert against these directly so the cache is
 * exercised as a behaviour, not as a string-equality coincidence.
 */
interface MarkdownProcessorStats {
  readonly hits: () => number;
  readonly misses: () => number;
}

export type MarkdownProcessor = ((content: string) => string) & {
  readonly stats: MarkdownProcessorStats;
};

export interface MarkdownProcessorRenderEnv {
  readonly restoreProtectedLatex?: (content: string) => string;
}

interface ProtectedRef {
  readonly refType: string;
  readonly label: string;
}

function defaultFormatLatexReference(refType: string, label: string): string {
  const safeAttrLabel = escapeAttr(label);
  const safeTextLabel = escapeText(label);
  return `<span class="latex-ref clickable-link" data-label="${safeAttrLabel}" role="button" tabindex="0">\\${refType}{${safeTextLabel}}</span>`;
}

function protectLatexReferences(content: string): {
  content: string;
  refs: ProtectedRef[];
  placeholder: RegExp;
} {
  const refs: ProtectedRef[] = [];
  const tag = selectPlaceholderTag(content, 'LATEX-REF');
  const protectedContent = content.replaceAll(
    /\\(ref|cref|eqref)\{([^}]+)\}/g,
    (_match, refType: string, label: string) => {
      const index = refs.push({ refType, label }) - 1;
      return `@@${tag}-${index}@@`;
    },
  );
  return {
    content: protectedContent,
    refs,
    placeholder: new RegExp(`@@${tag}-(\\d+)@@`, 'g'),
  };
}

function restoreLatexReferences(
  content: string,
  placeholder: RegExp,
  refs: ProtectedRef[],
  format: LatexReferenceFormatter,
): string {
  return content.replaceAll(placeholder, (match, rawIndex) => {
    const index = Number(rawIndex);
    const ref = refs[index];
    return ref ? format(ref.refType, ref.label) : match;
  });
}

// Inline `$…$` requires both delimiters to be unescaped (`\$` is a literal
// dollar in LaTeX, not a delimiter) and on the same line, which keeps stray
// currency `$` from being captured and avoids cascading mis-splits. One or
// more adjacent spans chain so `$a$$b$` shields as a single unit.
const INLINE_MATH_SPAN_PATTERN =
  /(?<!\\)\$(?!\$)[^\n$]+?(?<![\\$])\$(?:\$(?!\$)[^\n$]+?(?<![\\$])\$)*/g;

// Display and inline delimiter regexes used by the render shield before the
// bounded inline-dollar scanner runs, and by the lax HTML-normalize shield.
const DISPLAY_MATH_SPAN_PATTERNS: readonly RegExp[] = [
  /\$\$[\s\S]+?\$\$/g, // $$ … $$  (display, may span lines)
  /(?<!\\)\\\[[\s\S]+?(?<!\\)\\\]/g, // \[ … \]  (display)
  /(?<!\\)\\\([\s\S]+?(?<!\\)\\\)/g, // \( … \)  (inline)
];

// Lax HTML-normalize math pattern set: display fences first so `$…$` never
// splits a `$$…$$`, then the intentionally lax inline `$…$` regex.
const MATH_SPAN_PATTERNS: readonly RegExp[] = [
  ...DISPLAY_MATH_SPAN_PATTERNS,
  INLINE_MATH_SPAN_PATTERN,
];

// Replace every match of `patterns` with an indexed `@@<tag>-N@@` placeholder,
// appending the captured matches to `items` so later shields share one restore
// pass. `tag` must already be collision-free (see selectPlaceholderTag).
function protectPatternsInto(
  content: string,
  patterns: readonly RegExp[],
  tag: string,
  items: string[],
  preserveBlockquotePrefixes: boolean,
): string {
  let out = content;
  for (const pattern of patterns) {
    out = out.replaceAll(pattern, (match, ...args: unknown[]) => {
      const offset = args.at(-2) as number;
      const source = args.at(-1) as string;
      if (preserveBlockquotePrefixes && match.includes('\n')) {
        // Keep Markdown blockquote prefixes visible to the parser instead of
        // collapsing an entire quoted display span into one placeholder line.
        const firstLineStart = source.lastIndexOf('\n', offset - 1) + 1;
        const firstLinePrefix = source.slice(firstLineStart, offset);
        const firstContainerPrefix =
          /^(?:(?:[ \t]*>[ \t]?)|(?:[ \t]*(?:[-+*]|\d+[.)])[ \t]+))+/u.exec(
            firstLinePrefix,
          )?.[0] ?? '';
        const quoteDepth = [...firstContainerPrefix].filter(
          (char) => char === '>',
        ).length;
        const requiredPrefix = new RegExp(
          `^(?:[ \\t]*>[ \\t]?){${quoteDepth}}`,
          'u',
        );
        const lines = match.split('\n');
        const remainingLines = lines.slice(1);
        const remainingPrefixes = remainingLines.map(
          (line) => requiredPrefix.exec(line)?.[0],
        );
        const availablePrefix = new RegExp(
          `^(?:[ \\t]*>[ \\t]?){1,${Math.max(quoteDepth, 1)}}`,
          'u',
        );
        const availablePrefixes = remainingLines.map(
          (line) => availablePrefix.exec(line)?.[0],
        );
        const isQuotedSpan =
          quoteDepth > 0 &&
          remainingPrefixes.at(-1) !== undefined &&
          remainingPrefixes.every(
            (prefix, index) =>
              prefix !== undefined ||
              (remainingLines[index]?.trim().length ?? 0) > 0,
          );
        if (!isQuotedSpan) {
          const index = items.push(match) - 1;
          return `@@${tag}-${index}@@`;
        }
        return lines
          .map((line, lineIndex) => {
            const retainedPrefix =
              lineIndex === 0 ? '' : (remainingPrefixes[lineIndex - 1] ?? '');
            const contentPrefix =
              lineIndex === 0 ? '' : (availablePrefixes[lineIndex - 1] ?? '');
            const index = items.push(line.slice(contentPrefix.length)) - 1;
            return `${retainedPrefix}@@${tag}-${index}@@`;
          })
          .join('\n');
      }
      const index = items.push(match) - 1;
      return `@@${tag}-${index}@@`;
    });
  }
  return out;
}

function protectByPatterns(
  content: string,
  patterns: readonly RegExp[],
  tag: string,
  preserveBlockquotePrefixes = false,
): { content: string; restore: (value: string) => string } {
  const items: string[] = [];
  const selectedTag = selectPlaceholderTag(content, tag);
  const protectedContent = protectPatternsInto(
    content,
    patterns,
    selectedTag,
    items,
    preserveBlockquotePrefixes,
  );
  const placeholder = new RegExp(`@@${selectedTag}-(\\d+)@@`, 'g');
  return {
    content: protectedContent,
    restore: (value) => restorePlaceholders(value, placeholder, items),
  };
}

interface BegEndEnvironmentMatch {
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly lineContentStarts: readonly number[];
}

interface SourceRange {
  readonly start: number;
  readonly end: number;
}

interface BegEndEnvironmentProbe {
  collect(
    content: string,
    excludedRanges: readonly SourceRange[],
  ): readonly BegEndEnvironmentMatch[];
}

// A tiny markdown-it block probe that records exactly where texmath's
// `beg_end` rule would open an environment. It is a faithful container/fence-
// aware replacement for the source-level regex: it runs inside markdown-it's
// block parser, so it inherits bMarks/tShift, container prefix stripping, lazy
// list continuations, and fence consumption for free. It also installs the
// same paragraph-interruption rule the webview's texmath plugin uses, which is
// what lets `10. Formula:\n    \begin{align}` open an environment on the
// indented continuation line. The probe returns true to consume a match (but
// pushes no token), so the recorded match set follows texmath's parse exactly.
function createProbeMarkdownIt(options: {
  readonly breaks: boolean;
  readonly linkify: boolean;
  readonly html: boolean;
}): MarkdownItInstance {
  const probe = new MarkdownIt({
    breaks: options.breaks,
    linkify: options.linkify,
    html: options.html,
  });
  if (options.linkify) {
    probe.linkify.set({ fuzzyLink: true, urlAuth: true });
  }
  return probe;
}

// Binary search over a non-decreasing `valueAt(index)`: the first index whose
// value is strictly greater than `target` (== the count of entries <= target).
function upperBoundIndex(
  length: number,
  target: number,
  valueAt: (index: number) => number,
): number {
  let low = 0;
  let high = length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (valueAt(mid) <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function createBegEndEnvironmentProbe(
  probe: MarkdownItInstance,
): BegEndEnvironmentProbe {
  let active = false;
  let matches: BegEndEnvironmentMatch[] = [];
  let closersByEnv = new Map<string, number[]>();
  let excludedRanges: readonly SourceRange[] = [];
  const beginEnvPattern = /\\begin\{([a-z]+)\}/y;

  const isInsideExcludedRange = (position: number): boolean => {
    const after = upperBoundIndex(
      excludedRanges.length,
      position,
      (index) => excludedRanges[index]!.start,
    );
    const range = excludedRanges[after - 1];
    return range !== undefined && position < range.end;
  };

  const firstCloserAfter = (closers: readonly number[], openEnd: number) => {
    const after = upperBoundIndex(
      closers.length,
      openEnd,
      (index) => closers[index]!,
    );
    return after < closers.length ? closers[after]! : undefined;
  };

  const rule = (
    state: StateBlock,
    startLine: number,
    _endLine: number,
    silent: boolean,
  ): boolean => {
    if (!active) return false;
    const pos = state.bMarks[startLine]! + state.tShift[startLine]!;
    if (isInsideExcludedRange(pos)) return false;
    const source = state.src;
    if (source.charCodeAt(pos) !== 0x5c) return false;
    beginEnvPattern.lastIndex = pos;
    const opener = beginEnvPattern.exec(source);
    if (opener === null) return false;
    const name = opener[1]!;
    const openEnd = beginEnvPattern.lastIndex;
    const closers = closersByEnv.get(name);
    if (closers === undefined) return false;
    const closeStart = firstCloserAfter(closers, openEnd);
    if (closeStart === undefined) return false;
    const closeEnd = closeStart + 4 + name.length + 2; // \end{name}
    // Last line whose block starts at or before the closer (bMarks[0] is 0).
    const closerLine =
      upperBoundIndex(
        state.bMarks.length,
        closeStart,
        (index) => state.bMarks[index]!,
      ) - 1;
    if (silent) return true;

    const lineContentStarts: number[] = [];
    for (let line = startLine; line <= closerLine; line++) {
      lineContentStarts.push(state.bMarks[line]! + state.tShift[line]!);
    }
    matches.push({
      start: pos,
      end: closeEnd,
      startLine,
      endLine: closerLine,
      lineContentStarts,
    });
    state.line = closerLine + 1;
    return true;
  };

  probe.block.ruler.before('fence', 'texra_beg_end_probe', rule, {});
  probe.block.ruler.before('paragraph', 'texra_beg_end_probe_interrupt', rule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });

  return {
    collect(
      content: string,
      ranges: readonly SourceRange[],
    ): readonly BegEndEnvironmentMatch[] {
      matches = [];
      excludedRanges = ranges;
      // Most messages have no environment delimiters; skip both markdown
      // parses entirely in that case.
      if (!content.includes('\\begin{') || !content.includes('\\end{')) {
        return matches;
      }

      // Cheap compatibility precheck: only pay for a markdown parse when at
      // least one lowercase opener name also has a lowercase closer.
      const openerNames = new Set<string>();
      for (const opener of content.matchAll(/\\begin\{([a-z]+)\}/g)) {
        openerNames.add(opener[1]!);
      }
      if (openerNames.size === 0) return matches;

      closersByEnv = new Map();
      for (const closer of content.matchAll(/\\end\{([a-z]+)\}/g)) {
        const name = closer[1]!;
        const positions = closersByEnv.get(name) ?? [];
        positions.push(closer.index);
        closersByEnv.set(name, positions);
      }
      if (![...openerNames].some((name) => closersByEnv.has(name))) {
        return matches;
      }

      active = true;
      try {
        probe.parse(content, {});
      } finally {
        active = false;
      }
      if (matches.length === 0) return matches;

      // Only pay for a second (plain) parse when a candidate match could cross
      // a fence; the probe parse consumed math blocks, so it cannot enumerate
      // fences for the decline check. (The finally block above already
      // deactivated the probe rule.)
      const fenceTokens = probe.parse(content, {});
      const fenceRanges: Array<readonly [number, number]> = [];
      for (const token of fenceTokens) {
        if (token.type === 'fence' && token.map !== null) {
          fenceRanges.push([token.map[0], token.map[1]]);
        }
      }

      // Keep the earlier deliberate fence-decline: texmath would match across
      // a fenced-code boundary, but shielding that would swallow the fence and
      // its prose into a math placeholder. Under-shield instead. This is the
      // one documented divergence from the webview's beg_end parse.
      return matches.filter(
        (match) =>
          !fenceRanges.some(
            ([start, end]) => match.startLine < end && match.endLine >= start,
          ),
      );
    },
  };
}

// Blockquote markers markdown-it will still need to see after an environment
// is shielded. The leading indentation before each `>` and the marker itself
// stay visible; any extra whitespace after the marker is list/continuation
// indent and is restored from the placeholder instead, matching the existing
// `\[…\]` blockquote-prefix behaviour.
function retainedBlockquotePrefix(prefix: string): string {
  return /^(?:(?:[ \t]*>[ \t]?))+/u.exec(prefix)?.[0] ?? '';
}

const LIST_MARKER_PREFIX_RE = /^(?:[ \t]*(?:[-+*]|\d+[.)])[ \t]+)/u;

function lineBoundaries(content: string): {
  readonly lineStarts: number[];
  readonly lineEnds: number[];
} {
  const lineStarts = [0];
  const lineEnds: number[] = [];
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) {
      lineEnds.push(index);
      lineStarts.push(index + 1);
    }
  }
  lineEnds.push(content.length);
  return { lineStarts, lineEnds };
}

function applyEnvironmentShields(
  content: string,
  matches: readonly BegEndEnvironmentMatch[],
  tag: string,
  items: string[],
): string {
  if (matches.length === 0) return content;
  const { lineStarts, lineEnds } = lineBoundaries(content);
  const sorted = matches.toSorted((a, b) => a.start - b.start);
  const pieces: string[] = [];
  let copiedUntil = 0;
  for (const match of sorted) {
    if (match.start < copiedUntil) continue;
    pieces.push(content.slice(copiedUntil, lineStarts[match.startLine]!));
    for (let line = match.startLine; line <= match.endLine; line++) {
      const contentStart = match.lineContentStarts[line - match.startLine]!;
      const lineStart = lineStarts[line]!;
      const lineEnd = lineEnds[line]!;
      const fullPrefix = content.slice(lineStart, contentStart);
      const retained = retainedBlockquotePrefix(fullPrefix);
      const remainder = fullPrefix.slice(retained.length);
      const hasListMarker = LIST_MARKER_PREFIX_RE.test(remainder);
      // Keep list markers visible on the line; move extra blockquote-
      // continuation indent into the item so markdown-it does not strip it
      // when it builds the list-item paragraph content.
      const moveIndentIntoItem = retained.length > 0 && !hasListMarker;
      pieces.push(moveIndentIntoItem ? retained : fullPrefix);
      const isLast = line === match.endLine;
      const contentEnd = isLast ? match.end : lineEnd;
      const item =
        (moveIndentIntoItem ? remainder : '') +
        content.slice(contentStart, contentEnd);
      if (item.length > 0) {
        const index = items.push(item) - 1;
        pieces.push(`@@${tag}-${index}@@`);
      }
      if (!isLast) pieces.push(content.slice(lineEnd, lineStarts[line + 1]!));
    }
    copiedUntil = match.end;
  }
  pieces.push(content.slice(copiedUntil));
  return pieces.join('');
}

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

// Display-math ranges texmath would consume before its `beg_end` block rule
// runs. The render/normalize shields apply these same display patterns after
// environment shielding, so an environment opener inside one of these ranges
// must not be shielded first.
function findDisplayMathRanges(content: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  for (const pattern of DISPLAY_MATH_SPAN_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const start = match.index ?? 0;
      ranges.push({ start, end: start + match[0].length });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function protectLatexMathSpansWithEnvironment(
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

function selectPlaceholderTag(content: string, requestedTag: string): string {
  let tag = requestedTag;
  while (content.includes(`@@${tag}-`)) tag += '@';
  return tag;
}

function restorePlaceholders(
  content: string,
  placeholder: RegExp,
  items: string[],
): string {
  // An item can itself carry a placeholder when spans nest across patterns
  // (a `\begin{…}…\end{…}` placeholder inside a later `$$…$$` / `\[…\]`
  // fence), so run to a fixpoint instead of a single pass. Nesting is acyclic
  // — a pattern's matches can capture earlier patterns' placeholders but never
  // their own — and selectPlaceholderTag keeps placeholder-shaped user text
  // out of the items, so the loop terminates.
  let restored = content;
  for (;;) {
    const next = restored.replaceAll(placeholder, (match, rawIndex) => {
      const item = items[Number(rawIndex)];
      return item ?? match;
    });
    if (next === restored) return restored;
    restored = next;
  }
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
    createProbeMarkdownIt({ breaks: false, linkify: true, html: false }),
  );
  return protectLatexMathSpansWithEnvironment(
    source,
    normalizeEnvironmentProbe,
    MATH_SPAN_PATTERNS,
  );
}

// LaTeX backslash-macros whose trailing character is CommonMark-escapable
// punctuation, so markdown-it's parser strips the backslash (`\;`→`;`,
// `\(`→`(`, …). These are the math spacing macros (`\,` `\;` `\:` `\!`), the
// inline/display math delimiters (`\(` `\)` `\[` `\]`) and literal braces
// (`\{` `\}`) — all meaningful LaTeX and effectively never an intentional
// markdown escape in math output. We deliberately exclude `\$` `\#` `\&` `\%`
// `\_` `\*` etc., which carry real markdown-escape semantics.
const LATEX_MACRO = /\\([,;:!(){}[\]])/g;

/** FNV-1a hash → base-36 string. Cheap, no crypto needs here. */
function hashContent(str: string): string {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(36);
}

export function createMarkdownProcessor(
  config: MarkdownProcessorConfig,
): MarkdownProcessor {
  const format = config.formatLatexReference ?? defaultFormatLatexReference;
  const cache = new LRUCache<string, string>({
    max: MAX_CACHE_ENTRIES,
    maxSize: MAX_CACHE_TOTAL_CHARS,
    sizeCalculation: (value) => value.length,
  });
  let hitCount = 0;
  let missCount = 0;
  let environmentProbe: BegEndEnvironmentProbe | undefined;

  const processor = ((content: string): string => {
    const key = hashContent(content);
    const cached = cache.get(key);
    if (cached !== undefined) {
      hitCount += 1;
      return cached;
    }
    missCount += 1;

    // The CLI shield records offsets against the string markdown-it parses.
    // markdown-it core normalizes CRLF / bare CR to LF before block rules run,
    // so normalize once here and let the whole render pipeline operate on LF.
    const source = config.protectLatexMath
      ? content.replaceAll(/\r\n?/g, '\n')
      : content;

    // Protect in widening order (refs → math spans → stray macros); restore in
    // reverse so a ref placeholder revealed inside a restored span is still
    // formatted. After span protection, only out-of-span macros remain to net.
    const {
      content: refProtected,
      refs,
      placeholder: refPlaceholder,
    } = protectLatexReferences(source);
    const mathProtection = config.protectLatexMath
      ? protectLatexMathSpansWithEnvironment(
          refProtected,
          (environmentProbe ??= createBegEndEnvironmentProbe(
            createProbeMarkdownIt({
              breaks: config.renderer.options.breaks,
              linkify: config.renderer.options.linkify,
              html: config.renderer.options.html,
            }),
          )),
          DISPLAY_MATH_SPAN_PATTERNS,
          protectRenderInlineDollarSpans,
        )
      : { content: refProtected, restore: (value: string) => value };
    const mathProtected = mathProtection.content;
    const macroProtection = config.protectLatexMath
      ? protectByPatterns(mathProtected, [LATEX_MACRO], 'LATEX-MACRO')
      : { content: mathProtected, restore: (value: string) => value };
    const protectedContent = macroProtection.content;
    // OpenAI reasoning summaries sometimes omit the line break before a bold
    // heading mid-sentence (".**Heading**" → no break). Force one.
    const formatted = protectedContent.replaceAll(/\.(\*\*[A-Z])/g, '.\n$1');

    const restoreProtectedLatex = (value: string): string => {
      let restored = value;
      if (config.protectLatexMath) {
        restored = macroProtection.restore(restored);
        restored = mathProtection.restore(restored);
      }
      return restoreLatexReferences(restored, refPlaceholder, refs, format);
    };

    // markdown-it v15's `render(src, env)` forwards `env` to renderer rules,
    // so the env object — carrying `restoreProtectedLatex` — reaches them
    // without the old cast.
    const rendered = config.renderer.render(formatted, {
      restoreProtectedLatex,
    });
    const result = restoreProtectedLatex(rendered);

    // lru-cache's `sizeCalculation` rejects zero, so skip caching the empty
    // render (e.g. content that's only a link-reference definition).
    if (result.length > 0 && result.length <= MAX_CACHE_ENTRY_CHARS) {
      cache.set(key, result);
    }

    return result;
  }) as MarkdownProcessor;

  Object.defineProperty(processor, 'stats', {
    value: {
      hits: () => hitCount,
      misses: () => missCount,
    } satisfies MarkdownProcessorStats,
    enumerable: false,
  });
  return processor;
}
