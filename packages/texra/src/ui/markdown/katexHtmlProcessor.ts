/**
 * Markdown → HTML processor preconfigured with the TeXRA KaTeX math pipeline:
 * `markdown-it-texmath` over the KaTeX engine with the project macro set,
 * plus the shared hljs highlight hook. Single wiring point for HTML-targeting
 * hosts (the progress view webview); only the bits that legitimately differ
 * per host are exposed as options.
 *
 * The texmath and KaTeX imports live here, not in `createMarkdownRenderer`,
 * so hosts that never render math (the CLI TUI) keep them out of their
 * bundle. Import directly from `@ui/markdown/katexHtmlProcessor`.
 */

import katex from 'katex';
import texmath from 'markdown-it-texmath';

import { highlightCode } from '@texra/shared/highlighting/highlightCode';

import {
  createMarkdownProcessor,
  type MarkdownProcessor,
} from './createMarkdownProcessor';
import {
  createMarkdownRenderer,
  type MarkdownItInstance,
} from './createMarkdownRenderer';
import { katexMacros } from './katexMacros';

interface KatexHtmlProcessorOptions {
  /** CSS colour for KaTeX parse errors (custom property or literal). */
  readonly errorColor: string;
}

/** The delimiter set every host renders; texmath takes it verbatim. */
const DELIMITERS = Object.freeze(['dollars', 'brackets', 'beg_end']);

const PARAGRAPH_INTERRUPTION_CHAINS = Object.freeze([
  'paragraph',
  'reference',
  'blockquote',
  'list',
]);

/** Allow the display-math rules to interrupt an adjacent paragraph. */
function addDisplayMathParagraphInterruptions(md: MarkdownItInstance): void {
  const blockRules = [
    ...texmath.rules.dollars.block,
    ...texmath.rules.brackets.block,
    ...texmath.rules.beg_end.block,
  ];

  for (const [index, rule] of blockRules.entries()) {
    md.block.ruler.before(
      'paragraph',
      `texmath_block_interrupt_${index}`,
      texmath.block(rule),
      { alt: [...PARAGRAPH_INTERRUPTION_CHAINS] },
    );
  }
}

export function createKatexHtmlProcessor(
  options: KatexHtmlProcessorOptions,
): MarkdownProcessor {
  type TexmathFn = Parameters<MarkdownItInstance['use']>[0];
  const renderer = createMarkdownRenderer({
    highlight: highlightCode,
    usePlugin: (md) => {
      const configured = md.use(texmath as unknown as TexmathFn, {
        engine: katex,
        delimiters: [...DELIMITERS],
        katexOptions: {
          throwOnError: false,
          errorColor: options.errorColor,
          macros: katexMacros,
        },
      });
      addDisplayMathParagraphInterruptions(configured);
      return configured;
    },
  });
  return createMarkdownProcessor({ renderer });
}
