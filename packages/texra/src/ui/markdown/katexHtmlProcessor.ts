/**
 * Markdown → HTML processor preconfigured with the TeXRA KaTeX math pipeline:
 * `markdown-it-texmath` over the KaTeX engine with the project macro set,
 * plus the shared hljs highlight hook. Single wiring point for HTML-targeting
 * hosts (the progress view webview).
 *
 * The texmath and KaTeX imports live here, not in `createMarkdownRenderer`,
 * so hosts that never render math (the CLI TUI) keep them out of their
 * bundle. Import directly from `@ui/markdown/katexHtmlProcessor`.
 */

import katex from 'katex';
import texmath from 'markdown-it-texmath';

import { highlightCode } from '@ui/highlighting/highlightCode';

import {
  createMarkdownProcessor,
  type MarkdownProcessor,
} from './createMarkdownProcessor';
import {
  createMarkdownRenderer,
  type MarkdownItInstance,
} from './createMarkdownRenderer';
import { katexMacros } from './katexMacros';

/** CSS colour for KaTeX parse errors: the design system's error token. */
const ERROR_COLOR = 'var(--color-error)';

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

export function createKatexHtmlProcessor(): MarkdownProcessor {
  const renderer = createMarkdownRenderer({
    highlight: highlightCode,
    usePlugin: (md) => {
      const configured = md.use(texmath, {
        engine: katex,
        delimiters: [...DELIMITERS],
        katexOptions: {
          throwOnError: false,
          errorColor: ERROR_COLOR,
          macros: katexMacros,
        },
      });
      addDisplayMathParagraphInterruptions(configured);
      return configured;
    },
  });
  return createMarkdownProcessor({ renderer });
}
