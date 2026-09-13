// Cached markdown processor: protects LaTeX references from markdown parsing,
// applies a small pre-pass for OpenAI-style headings, renders through the
// supplied `MarkdownIt`, and memoises the output keyed by content hash.
//
// Each host (webview HTML, CLI ANSI) builds its own processor so caches stay
// isolated — the cached values are not interchangeable between renderers.

import { LRUCache } from 'lru-cache';

import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';

import {
  createBegEndEnvironmentProbe,
  createProbeMarkdownIt,
  type BegEndEnvironmentProbe,
} from './begEndEnvironmentProbe';
import { type MarkdownItInstance } from './createMarkdownRenderer';
import {
  protectLatexMathSpansWithEnvironment,
  protectRenderInlineDollarSpans,
} from './latexMathShield';
import {
  DISPLAY_MATH_SPAN_PATTERNS,
  LATEX_MACRO,
  protectByPatterns,
  selectPlaceholderTag,
} from './latexPlaceholders';

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

/**
 * Two FNV-1a lanes → one base-36 key. Cheap, no crypto needs here — but the
 * digest is the cache's identity key, so a collision would render one message
 * as another. 32 bits is not enough for that over a long session (a 2000-entry
 * window churns far more than 2000 distinct bodies), so two lanes run with
 * different primes and are joined by a delimiter (concatenating two
 * variable-length forms would re-import collisions across the boundary), with
 * the length folded in as a third component.
 */
function hashContent(str: string): string {
  let a = 2166136261;
  let b = 2166136261;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    a = ((a ^ code) * 16777619) >>> 0;
    b = ((b ^ code) * 16777639) >>> 0;
  }
  return `${a.toString(36)}.${b.toString(36)}.${str.length.toString(36)}`;
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
            createProbeMarkdownIt(),
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

    // Each protection carries its own restore — identity when that shield is
    // off — so `protectLatexMath` is not re-read here.
    const restoreProtectedLatex = (value: string): string =>
      restoreLatexReferences(
        mathProtection.restore(macroProtection.restore(value)),
        refPlaceholder,
        refs,
        format,
      );

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
