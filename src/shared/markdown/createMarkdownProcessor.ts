// Cached markdown processor: protects LaTeX references from markdown parsing,
// applies a small pre-pass for OpenAI-style headings, renders through the
// supplied `MarkdownIt`, and memoises the output keyed by content hash.
//
// Each host (webview HTML, CLI ANSI) builds its own processor so caches stay
// isolated — the cached values are not interchangeable between renderers.

import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';

import type { MarkdownItInstance } from './createMarkdownRenderer';

const DEFAULT_CACHE_BUDGET: CacheBudget = {
  maxEntries: 2000,
  maxEntryChars: 200_000,
  maxTotalChars: 2_000_000,
};

export interface CacheBudget {
  readonly maxEntries: number;
  readonly maxEntryChars: number;
  readonly maxTotalChars: number;
}

export interface LatexReferenceFormatter {
  /**
   * Render a `\ref{label}` / `\cref{label}` / `\eqref{label}` after the
   * markdown body has been rendered. Webview emits a clickable span; CLI
   * emits a dim ANSI underline.
   */
  (refType: string, label: string): string;
}

export interface MarkdownProcessorConfig {
  readonly renderer: MarkdownItInstance;
  /** Override the cache budget; defaults match the legacy webview limits. */
  readonly cacheBudget?: CacheBudget;
  /** Disable the LRU entirely (useful for tests). */
  readonly disableCache?: boolean;
  /**
   * Formatter for `\ref{…}` / `\cref{…}` / `\eqref{…}` placeholders. Defaults
   * to the webview-style `<span class="latex-ref clickable-link">` so existing
   * progress-view callers keep their behaviour.
   */
  readonly formatLatexReference?: LatexReferenceFormatter;
}

/**
 * Test-only telemetry returned alongside the processor. `hits` increments
 * every time the LRU returns a cached value; `misses` every time the
 * renderer runs. Tests assert against these directly so the cache is
 * exercised as a behaviour, not as a string-equality coincidence.
 */
export interface MarkdownProcessorStats {
  readonly hits: () => number;
  readonly misses: () => number;
}

export type MarkdownProcessor = ((content: string) => string) & {
  readonly stats: MarkdownProcessorStats;
};

interface ProtectedRef {
  readonly refType: string;
  readonly label: string;
}

const REF_PLACEHOLDER = /@@LATEX-REF-(\d+)@@/g;

function defaultFormatLatexReference(refType: string, label: string): string {
  const safeAttrLabel = escapeAttr(label);
  const safeTextLabel = escapeText(label);
  return `<span class="latex-ref clickable-link" data-label="${safeAttrLabel}">\\${refType}{${safeTextLabel}}</span>`;
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
  const budget = config.cacheBudget ?? DEFAULT_CACHE_BUDGET;
  const format = config.formatLatexReference ?? defaultFormatLatexReference;
  const cache: Map<string, string> | undefined = config.disableCache
    ? undefined
    : new Map<string, string>();
  let cacheChars = 0;
  let hitCount = 0;
  let missCount = 0;

  const processor = ((content: string): string => {
    const key = cache ? hashContent(content) : undefined;
    if (cache && key !== undefined && cache.has(key)) {
      const cached = cache.get(key);
      if (cached === undefined) return '';
      hitCount += 1;
      // Promote to MRU.
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    missCount += 1;

    const { content: protectedContent, refs } = protectLatexReferences(content);
    // OpenAI reasoning summaries sometimes omit the line break before a bold
    // heading mid-sentence (".**Heading**" → no break). Force one.
    const formatted = protectedContent.replaceAll(/\.(\*\*[A-Z])/g, '.\n$1');

    const rendered = config.renderer.render(formatted);
    const result = restoreLatexReferences(rendered, refs, format);

    if (cache && key !== undefined && result.length <= budget.maxEntryChars) {
      while (
        cache.size >= budget.maxEntries ||
        cacheChars + result.length > budget.maxTotalChars
      ) {
        const firstKey = cache.keys().next().value;
        if (firstKey === undefined) break;
        const firstValue = cache.get(firstKey);
        cache.delete(firstKey);
        if (firstValue) cacheChars -= firstValue.length;
      }
      cacheChars += result.length;
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
