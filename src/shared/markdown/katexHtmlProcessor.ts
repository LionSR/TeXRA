/**
 * Markdown → HTML processor preconfigured with the TeXRA KaTeX math pipeline:
 * the KaTeX engine with the project macro set, plus the shared hljs highlight
 * hook. Single wiring point for HTML-targeting hosts (progress view webview,
 * HTML chat export); only the bits that legitimately differ per host are
 * exposed as options.
 *
 * Like `texmathPlugin`, this module is intentionally NOT re-exported from the
 * `@shared/markdown` barrel — it would pin katex and the side-effecting
 * `markdown-it-texmath` import into the module graph for hosts that never
 * render math. Import directly from `@shared/markdown/katexHtmlProcessor`.
 */

import katex from 'katex';

import { highlightCode } from '@shared/highlighting/highlightCode';

import {
  createMarkdownProcessor,
  type LatexReferenceFormatter,
  type MarkdownProcessor,
} from './createMarkdownProcessor';
import { createMarkdownRenderer } from './createMarkdownRenderer';
import { createTexmathPlugin } from './texmathPlugin';
import { katexMacros } from './katexMacros';

export interface KatexHtmlProcessorOptions {
  /** CSS colour for KaTeX parse errors (custom property or literal). */
  readonly errorColor: string;
  /** Override how `\ref`/`\eqref`-style references are emitted. */
  readonly formatLatexReference?: LatexReferenceFormatter;
}

export function createKatexHtmlProcessor(
  options: KatexHtmlProcessorOptions,
): MarkdownProcessor {
  const renderer = createMarkdownRenderer({
    highlight: highlightCode,
    usePlugin: createTexmathPlugin({
      engine: katex,
      engineOptions: {
        throwOnError: false,
        errorColor: options.errorColor,
        macros: katexMacros,
      },
    }),
  });
  return createMarkdownProcessor({
    renderer,
    formatLatexReference: options.formatLatexReference,
  });
}
