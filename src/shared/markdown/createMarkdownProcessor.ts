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

// Render-time inline `$…$` mirrors texmath's `dollars` inline rule exactly:
// the same `$_pre`/`$_post` adjacency guards (no digit before the opener, no
// whitespace just inside either delimiter, no digit after the closer) and the
// same single-span body. texmath's body is `(?:[^\s\\]|\S.*?[^\s\\])`,
// whose first alternative lets a one-character body match and whose second
// permits interior `$` — so `Cost $5 then *ten* $x$` is one math span whose
// body ends at the *last* dollar, while `Cost $5 then *ten* $10` is prose
// (the only closer is preceded by whitespace). Adjacent spans are matched
// back-to-back by the global scan, keeping `$a$$b$` verbatim.
const RENDER_INLINE_MATH_SPAN_PATTERN =
  /(?<![\\\d])\$((?:[^\s\\]|\S[^\n]*?[^\s\\]))\$(?!\d)/g;

// Lax environment shielding used by `htmlMarkdownNormalize`: that path has no
// markdown-it block state to consult, so it keeps the previous line-anchored
// regex. It recognizes a `\\begin{env}…\\end{env}` only where a texmath block
// could start at top level (line start, optional blockquote/list prefix, up to
// three spaces) and declines any span that would cross a fenced-code boundary
// rather than swallowing the intervening prose into a placeholder. The render
// shield below does not use this regex; it delegates to the container/fence-
// aware probe so list-continuation offsets and fenced interiors match
// markdown-it exactly.
const BEG_END_MATH_SPAN_PATTERN =
  /(?<=^(?:(?:[ \t]*>[ \t]?)|(?:[ \t]*(?:[-+*]|\d+[.)])[ \t]+))*[ ]{0,3})\\begin\{([a-z]+)\}(?:(?!^(?:(?:[ \t]*>[ \t]?)|(?:[ \t]*(?:[-+*]|\d+[.)])[ \t]+))*[ ]{0,3}(?:`{3,}|~{3,}))[\s\S])+?(?<!\\)\\end\{\1\}/gm;

// Shared pattern vocabulary. Order matters: display fences before inline ones
// so `$…$` never splits a `$$…$$`, and the legacy environment regex stays last
// for the fail-loud identity swap below. The render and HTML-normalize shields
// both derive their active sets from this list and drop the environment regex
// in favour of the container/fence-aware probe.
const MATH_SPAN_PATTERNS: readonly RegExp[] = [
  /\$\$[\s\S]+?\$\$/g, // $$ … $$  (display, may span lines)
  /(?<!\\)\\\[[\s\S]+?(?<!\\)\\\]/g, // \[ … \]  (display)
  /(?<!\\)\\\([\s\S]+?(?<!\\)\\\)/g, // \( … \)  (inline)
  INLINE_MATH_SPAN_PATTERN, // $ … $  (one or more adjacent inline spans, single line)
  BEG_END_MATH_SPAN_PATTERN, // \begin{env} … \end{env}  (texmath beg_end)
];

// The render shield swaps in the texmath-adjacent inline pattern and drops
// the legacy environment regex; environments are shielded by the block-state
// probe instead. The HTML normalizer keeps the lax inline pattern but likewise
// drops the environment regex (see NORMALIZE_MATH_SPAN_PATTERNS).
const RENDER_MATH_SPAN_PATTERNS: readonly RegExp[] = MATH_SPAN_PATTERNS.filter(
  (pattern) => pattern !== BEG_END_MATH_SPAN_PATTERN,
).map((pattern) =>
  pattern === INLINE_MATH_SPAN_PATTERN
    ? RENDER_INLINE_MATH_SPAN_PATTERN
    : pattern,
);
// Fail loud rather than silently render-shield with the lax inline pattern if
// MATH_SPAN_PATTERNS ever drops or renames the inline entry.
if (!RENDER_MATH_SPAN_PATTERNS.includes(RENDER_INLINE_MATH_SPAN_PATTERN)) {
  throw new Error(
    'MATH_SPAN_PATTERNS no longer carries the inline $…$ entry to swap',
  );
}

// The HTML normalizer keeps the lax inline `$…$` contract but drops the lax
// environment regex: its environments are container-aware too, so a continued
// ordered-list environment is shielded before tag normalization can touch it.
const NORMALIZE_MATH_SPAN_PATTERNS: readonly RegExp[] =
  MATH_SPAN_PATTERNS.filter((pattern) => pattern !== BEG_END_MATH_SPAN_PATTERN);

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
): { content: string; items: string[]; placeholder: RegExp } {
  const items: string[] = [];
  const selectedTag = selectPlaceholderTag(content, tag);
  const protectedContent = protectPatternsInto(
    content,
    patterns,
    selectedTag,
    items,
    preserveBlockquotePrefixes,
  );
  return {
    content: protectedContent,
    items,
    placeholder: new RegExp(`@@${selectedTag}-(\\d+)@@`, 'g'),
  };
}

interface BegEndEnvironmentMatch {
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly lineContentStarts: readonly number[];
}

interface BegEndEnvironmentProbe {
  collect(content: string): readonly BegEndEnvironmentMatch[];
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

function createBegEndEnvironmentProbe(
  probe: MarkdownItInstance,
): BegEndEnvironmentProbe {
  let active = false;
  let matches: BegEndEnvironmentMatch[] = [];
  let closersByEnv = new Map<string, number[]>();
  const beginEnvPattern = /\\begin\{([a-z]+)\}/y;

  const firstCloserAfter = (closers: readonly number[], openEnd: number) => {
    let low = 0;
    let high = closers.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (closers[mid]! > openEnd) high = mid;
      else low = mid + 1;
    }
    return low < closers.length ? closers[low]! : undefined;
  };

  const rule = (
    state: StateBlock,
    startLine: number,
    _endLine: number,
    silent: boolean,
  ): boolean => {
    if (!active) return false;
    const pos = state.bMarks[startLine]! + state.tShift[startLine]!;
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
    let low = 0;
    let high = state.bMarks.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (state.bMarks[mid]! <= closeStart) low = mid;
      else high = mid - 1;
    }
    const closerLine = low;
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
    collect(content: string): readonly BegEndEnvironmentMatch[] {
      matches = [];
      closersByEnv = new Map();
      const closerPattern = /\\(?:end)\{([a-z]+)\}/g;
      for (const closer of content.matchAll(closerPattern)) {
        const name = closer[1]!;
        const positions = closersByEnv.get(name) ?? [];
        positions.push(closer.index);
        closersByEnv.set(name, positions);
      }

      active = false;
      const fenceTokens = probe.parse(content, {});
      const fenceRanges: Array<readonly [number, number]> = [];
      for (const token of fenceTokens) {
        if (token.type === 'fence' && token.map !== null) {
          fenceRanges.push([token.map[0], token.map[1]]);
        }
      }

      active = true;
      try {
        probe.parse(content, {});
      } finally {
        active = false;
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
  const sorted = [...matches].sort((a, b) => a.start - b.start);
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

function protectLatexMathSpansWithEnvironment(
  content: string,
  patterns: readonly RegExp[],
  environmentProbe: BegEndEnvironmentProbe,
): {
  content: string;
  restore: (value: string) => string;
} {
  const items: string[] = [];
  const selectedTag = selectPlaceholderTag(content, 'LATEX-MATH');
  const patternProtected = protectPatternsInto(
    content,
    patterns,
    selectedTag,
    items,
    true,
  );
  const matches = environmentProbe.collect(patternProtected);
  const envProtected = applyEnvironmentShields(
    patternProtected,
    matches,
    selectedTag,
    items,
  );
  const placeholder = new RegExp(`@@${selectedTag}-(\\d+)@@`, 'g');
  return {
    content: envProtected,
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
  // (an inline `$…$` inside a `\begin{…}…\end{…}` body), so run to a
  // fixpoint instead of a single pass. Nesting is acyclic — a pattern's
  // matches can capture earlier patterns' placeholders but never their own —
  // and selectPlaceholderTag keeps placeholder-shaped user text out of the
  // items, so the loop terminates.
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
 * `htmlMarkdownNormalize`'s math shield: the lax inline `$…$` set plus the
 * container/fence-aware environment probe. The normalize pass runs before the
 * renderer, so it needs the same list-continuation/blockquote awareness or a
 * `<br>` inside `10. Formula:\n    \begin{align}` would be mutated before the
 * render shield can protect it.
 */
export function protectLatexMathSpansForNormalize(content: string): {
  content: string;
  restore: (value: string) => string;
} {
  normalizeEnvironmentProbe ??= createBegEndEnvironmentProbe(
    createProbeMarkdownIt({ breaks: false, linkify: true, html: false }),
  );
  return protectLatexMathSpansWithEnvironment(
    content,
    NORMALIZE_MATH_SPAN_PATTERNS,
    normalizeEnvironmentProbe,
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
          RENDER_MATH_SPAN_PATTERNS,
          (environmentProbe ??= createBegEndEnvironmentProbe(
            createProbeMarkdownIt({
              breaks: config.renderer.options.breaks,
              linkify: config.renderer.options.linkify,
              html: config.renderer.options.html,
            }),
          )),
        )
      : { content: refProtected, restore: (value: string) => value };
    const mathProtected = mathProtection.content;
    const macroProtection = config.protectLatexMath
      ? protectByPatterns(mathProtected, [LATEX_MACRO], 'LATEX-MACRO')
      : { content: mathProtected, items: [], placeholder: /$^/g };
    const protectedContent = macroProtection.content;
    // OpenAI reasoning summaries sometimes omit the line break before a bold
    // heading mid-sentence (".**Heading**" → no break). Force one.
    const formatted = protectedContent.replaceAll(/\.(\*\*[A-Z])/g, '.\n$1');

    const restoreProtectedLatex = (value: string): string => {
      let restored = value;
      if (config.protectLatexMath) {
        restored = restorePlaceholders(
          restored,
          macroProtection.placeholder,
          macroProtection.items,
        );
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
