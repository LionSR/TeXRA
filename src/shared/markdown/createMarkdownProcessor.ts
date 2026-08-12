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
   * `$$…$$` / `\(…\)` / `\[…\]` spans as ordinary markdown and corrupts it two
   * ways: its CommonMark escape rule strips the backslash before escapable
   * punctuation (`\(`→`(`, `\;`→`;`, `\{`→`{`, `\,`→`,`), and its emphasis rule
   * eats `_{…}` subscripts (`a_{i}b_{j}` → `a<em>i</em>b_{j}`). We protect the
   * whole span, plus a safety net for stray spacing/brace macros (`\,` `\;`
   * `\:` `\!` `\(` `\)` `\[` `\]` `\{` `\}`) outside any span.
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

const REF_PLACEHOLDER = /@@LATEX-REF-(\d+)@@/g;

function defaultFormatLatexReference(refType: string, label: string): string {
  const safeAttrLabel = escapeAttr(label);
  const safeTextLabel = escapeText(label);
  return `<span class="latex-ref clickable-link" data-label="${safeAttrLabel}" role="button" tabindex="0">\\${refType}{${safeTextLabel}}</span>`;
}

function protectLatexReferences(content: string): {
  content: string;
  refs: ProtectedRef[];
} {
  const refs: ProtectedRef[] = [];
  const protectedContent = content.replaceAll(
    /\\(ref|cref|eqref)\{([^}]+)\}/g,
    (_match, refType: string, label: string) => {
      const index = refs.push({ refType, label }) - 1;
      return `@@LATEX-REF-${index}@@`;
    },
  );
  return { content: protectedContent, refs };
}

function restoreLatexReferences(
  content: string,
  refs: ProtectedRef[],
  format: LatexReferenceFormatter,
): string {
  return content.replaceAll(REF_PLACEHOLDER, (match, rawIndex) => {
    const index = Number(rawIndex);
    const ref = refs[index];
    return ref ? format(ref.refType, ref.label) : match;
  });
}

const MATH_PLACEHOLDER = /@@LATEX-MATH-(\d+)@@/g;

// Math spans whose body must reach the renderer verbatim. Order matters: the
// display fences are matched before the inline ones so `$…$` never splits a
// `$$…$$`. Inline `$…$` requires both delimiters to be unescaped (`\$` is a
// literal dollar in LaTeX, not a delimiter) and on the same line, which keeps
// stray currency `$` from being captured and avoids cascading mis-splits.
const MATH_SPAN_PATTERNS: readonly RegExp[] = [
  /\$\$[\s\S]+?\$\$/g, // $$ … $$  (display, may span lines)
  /\\\[[\s\S]+?\\\]/g, // \[ … \]  (display)
  /\\\([\s\S]+?\\\)/g, // \( … \)  (inline)
  /(?<!\\)\$(?!\$)[^\n$]+?(?<!\\)\$/g, // $ … $  (inline, single line, both $ unescaped)
];

// Replace every match of `patterns` with an indexed `@@<tag>-N@@` placeholder,
// returning the captured matches so restorePlaceholders can reinstate them.
function protectByPatterns(
  content: string,
  patterns: readonly RegExp[],
  tag: string,
): { content: string; items: string[] } {
  const items: string[] = [];
  let out = content;
  for (const pattern of patterns) {
    out = out.replaceAll(pattern, (match) => {
      const index = items.push(match) - 1;
      return `@@${tag}-${index}@@`;
    });
  }
  return { content: out, items };
}

function restorePlaceholders(
  content: string,
  placeholder: RegExp,
  items: string[],
): string {
  return content.replaceAll(placeholder, (match, rawIndex) => {
    const item = items[Number(rawIndex)];
    return item ?? match;
  });
}

const MACRO_PLACEHOLDER = /@@LATEX-MACRO-(\d+)@@/g;

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
    const { content: refProtected, refs } = protectLatexReferences(content);
    const { content: mathProtected, items: spans } = config.protectLatexMath
      ? protectByPatterns(refProtected, MATH_SPAN_PATTERNS, 'LATEX-MATH')
      : { content: refProtected, items: [] };
    const { content: protectedContent, items: macros } = config.protectLatexMath
      ? protectByPatterns(mathProtected, [LATEX_MACRO], 'LATEX-MACRO')
      : { content: mathProtected, items: [] };
    // OpenAI reasoning summaries sometimes omit the line break before a bold
    // heading mid-sentence (".**Heading**" → no break). Force one.
    const formatted = protectedContent.replaceAll(/\.(\*\*[A-Z])/g, '.\n$1');

    const restoreProtectedLatex = (value: string): string => {
      let restored = value;
      if (config.protectLatexMath) {
        restored = restorePlaceholders(restored, MACRO_PLACEHOLDER, macros);
        restored = restorePlaceholders(restored, MATH_PLACEHOLDER, spans);
      }
      return restoreLatexReferences(restored, refs, format);
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
