// Cached markdown processor: protects LaTeX references from markdown parsing,
// applies a small pre-pass for OpenAI-style headings, renders through the
// supplied `MarkdownIt`, and memoises the output keyed by content hash.
//
// Each host (webview HTML, CLI ANSI) builds its own processor so caches stay
// isolated — the cached values are not interchangeable between renderers.

import { LRUCache } from 'lru-cache';

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

// Render-time inline `$…$` adds the adjacency guards the webview's texmath
// applies to its `dollars` inline rule (`$_pre`/`$_post`): no digit before
// the opener, no whitespace just inside either delimiter, and no digit after
// the closer. `Cost $5 then *ten* $10` is prose to texmath (its emphasis
// stays live), so the CLI renderer must not shield it as math either. The
// HTML normalizer keeps the lax form above: there a math-shaped span's tags
// deliberately stay literal — the conservative choice while deciding which
// HTML to convert — pinned by the "preserves complete inline math beside
// token characters" suite.
const RENDER_INLINE_MATH_SPAN_PATTERN =
  /(?<![\\\d])\$(?!\$)(?!\s)[^\n$]+?(?<![\\$\s])\$(?!\d)(?:\$(?!\$)(?!\s)[^\n$]+?(?<![\\$\s])\$(?!\d))*/g;

// Environment spans mirror texmath's `beg_end` block rule, so the opener is
// only recognized where that rule can start one: at a block line start, after
// optional blockquote/list container prefixes and up to three spaces of
// indentation. An inline `prefix \begin{…}` stays prose, an escaped `\\begin`
// never opens (the anchor admits no preceding backslash), four-space
// indentation stays a code block, and starred variants like `align*` remain
// unshielded in both hosts (texmath's `[a-z]+` name class excludes them). The
// closer must be an unescaped `\end` naming the same environment, and a span
// that would cross a fenced-code boundary is declined: texmath never sees
// fenced content, so an opener inside one fence pairing a closer inside
// another would swallow the intervening prose into the placeholder —
// declining under-shields to the pre-fix rendering instead. Unmatched here,
// markdown-it eats `\\` row breaks as escapes and turns `*…*` inside the
// body into emphasis.
const BEG_END_MATH_SPAN_PATTERN =
  /(?<=^(?:(?:[ \t]*>[ \t]?)|(?:[ \t]*(?:[-+*]|\d+[.)])[ \t]+))*[ ]{0,3})\\begin\{([a-z]+)\}(?:(?!^(?:(?:[ \t]*>[ \t]?)|(?:[ \t]*(?:[-+*]|\d+[.)])[ \t]+))*[ ]{0,3}(?:`{3,}|~{3,}))[\s\S])+?(?<!\\)\\end\{\1\}/gm;

// Math spans whose body must reach the renderer verbatim. Order matters: the
// display fences are matched before the inline ones so `$…$` never splits a
// `$$…$$`, and the environment rule comes last so a `\begin{…}…\end{…}`
// nested inside a fence is consumed with its fence.
const MATH_SPAN_PATTERNS: readonly RegExp[] = [
  /\$\$[\s\S]+?\$\$/g, // $$ … $$  (display, may span lines)
  /(?<!\\)\\\[[\s\S]+?(?<!\\)\\\]/g, // \[ … \]  (display)
  /(?<!\\)\\\([\s\S]+?(?<!\\)\\\)/g, // \( … \)  (inline)
  INLINE_MATH_SPAN_PATTERN, // $ … $  (one or more adjacent inline spans, single line)
  BEG_END_MATH_SPAN_PATTERN, // \begin{env} … \end{env}  (texmath beg_end)
];

// The processor's render shield swaps in the texmath-adjacent inline pattern;
// htmlMarkdownNormalize keeps the lax default set above.
const RENDER_MATH_SPAN_PATTERNS: readonly RegExp[] = MATH_SPAN_PATTERNS.map(
  (pattern) =>
    pattern === INLINE_MATH_SPAN_PATTERN
      ? RENDER_INLINE_MATH_SPAN_PATTERN
      : pattern,
);

// Replace every match of `patterns` with an indexed `@@<tag>-N@@` placeholder,
// returning the captured matches so restorePlaceholders can reinstate them.
function protectByPatterns(
  content: string,
  patterns: readonly RegExp[],
  tag: string,
  preserveBlockquotePrefixes = false,
): { content: string; items: string[]; placeholder: RegExp } {
  const items: string[] = [];
  const selectedTag = selectPlaceholderTag(content, tag);
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
          return `@@${selectedTag}-${index}@@`;
        }
        return lines
          .map((line, lineIndex) => {
            const retainedPrefix =
              lineIndex === 0 ? '' : (remainingPrefixes[lineIndex - 1] ?? '');
            const contentPrefix =
              lineIndex === 0 ? '' : (availablePrefixes[lineIndex - 1] ?? '');
            const index = items.push(line.slice(contentPrefix.length)) - 1;
            return `${retainedPrefix}@@${selectedTag}-${index}@@`;
          })
          .join('\n');
      }
      const index = items.push(match) - 1;
      return `@@${selectedTag}-${index}@@`;
    });
  }
  return {
    content: out,
    items,
    placeholder: new RegExp(`@@${selectedTag}-(\\d+)@@`, 'g'),
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

/** Shields complete LaTeX math spans while another transform runs. */
export function protectLatexMathSpans(
  content: string,
  patterns: readonly RegExp[] = MATH_SPAN_PATTERNS,
): {
  content: string;
  restore: (value: string) => string;
} {
  const protectedMath = protectByPatterns(
    content,
    patterns,
    'LATEX-MATH',
    true,
  );
  return {
    content: protectedMath.content,
    restore: (value) =>
      restorePlaceholders(
        value,
        protectedMath.placeholder,
        protectedMath.items,
      ),
  };
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

  const processor = ((content: string): string => {
    const key = hashContent(content);
    const cached = cache.get(key);
    if (cached !== undefined) {
      hitCount += 1;
      return cached;
    }
    missCount += 1;

    // Protect in widening order (refs → math spans → stray macros); restore in
    // reverse so a ref placeholder revealed inside a restored span is still
    // formatted. After span protection, only out-of-span macros remain to net.
    const {
      content: refProtected,
      refs,
      placeholder: refPlaceholder,
    } = protectLatexReferences(content);
    const mathProtection = config.protectLatexMath
      ? protectLatexMathSpans(refProtected, RENDER_MATH_SPAN_PATTERNS)
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
