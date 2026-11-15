// Cached markdown processor: protects LaTeX references from markdown parsing,
// applies a small pre-pass for OpenAI-style headings, renders through the
// supplied `MarkdownIt`, and memoises the output keyed by content hash.
//
// Each host (webview HTML, CLI ANSI) builds its own processor so caches stay
// isolated — the cached values are not interchangeable between renderers.

import { LRUCache } from 'lru-cache';

import { escapeAttr, escapeText } from '@texra-ai/harness/schemas';

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
  holdPlaceholder,
  placeholderRestorer,
  selectPlaceholderTag,
} from './latexPlaceholders';

const MAX_CACHE_ENTRIES = 2000;
const MAX_CACHE_ENTRY_CHARS = 200_000;
const MAX_CACHE_TOTAL_CHARS = 2_000_000;

interface LatexReferenceFormatter {
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

export type MarkdownProcessor = (content: string) => string;

function defaultFormatLatexReference(refType: string, label: string): string {
  const safeAttrLabel = escapeAttr(label);
  const safeTextLabel = escapeText(label);
  return `<span class="latex-ref clickable-link" data-label="${safeAttrLabel}" role="button" tabindex="0">\\${refType}{${safeTextLabel}}</span>`;
}

/** Sets each `\ref`-like command aside as the markup `format` gives it. */
function protectLatexReferences(
  content: string,
  format: LatexReferenceFormatter,
): { content: string; restore: (value: string) => string } {
  const formatted: string[] = [];
  const tag = selectPlaceholderTag(content, 'LATEX-REF');
  return {
    content: content.replaceAll(
      /\\(ref|cref|eqref)\{([^}]+)\}/g,
      (_match, refType: string, label: string) =>
        holdPlaceholder(formatted, tag, format(refType, label)),
    ),
    restore: placeholderRestorer(tag, formatted),
  };
}

export function createMarkdownProcessor(
  config: MarkdownProcessorConfig,
): MarkdownProcessor {
  const format = config.formatLatexReference ?? defaultFormatLatexReference;
  // Keyed by the source text itself: a digest key could render one message
  // as another on a collision. The key counts toward the size bound.
  const cache = new LRUCache<string, string>({
    max: MAX_CACHE_ENTRIES,
    maxSize: MAX_CACHE_TOTAL_CHARS,
    sizeCalculation: (value, key) => value.length + key.length,
  });
  let environmentProbe: BegEndEnvironmentProbe | undefined;

  return (content: string): string => {
    const cached = cache.get(content);
    if (cached !== undefined) return cached;

    // The CLI shield records offsets against the string markdown-it parses.
    // markdown-it core normalizes CRLF / bare CR to LF before block rules run,
    // so normalize once here and let the whole render pipeline operate on LF.
    const source = config.protectLatexMath
      ? content.replaceAll(/\r\n?/g, '\n')
      : content;

    // Protect in widening order (refs → math spans → stray macros); restore in
    // reverse so a ref placeholder revealed inside a restored span is still
    // formatted. After span protection, only out-of-span macros remain to net.
    const { content: refProtected, restore: restoreReferences } =
      protectLatexReferences(source, format);
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
      restoreReferences(mathProtection.restore(macroProtection.restore(value)));

    // markdown-it v15's `render(src, env)` forwards `env` to renderer rules,
    // so the env object — carrying `restoreProtectedLatex` — reaches them
    // without the old cast.
    const rendered = config.renderer.render(formatted, {
      restoreProtectedLatex,
    });
    const result = restoreProtectedLatex(rendered);

    // lru-cache's `sizeCalculation` rejects zero, so skip caching the empty
    // render (e.g. content that's only a link-reference definition).
    if (
      result.length > 0 &&
      result.length + content.length <= MAX_CACHE_ENTRY_CHARS
    ) {
      cache.set(content, result);
    }

    return result;
  };
}
