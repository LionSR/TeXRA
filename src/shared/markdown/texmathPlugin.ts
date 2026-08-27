// `markdown-it-texmath` wiring lives in its own module so non-math hosts
// (the CLI TUI) don't pull texmath into their bundle. The webview imports
// `createTexmathPlugin` and threads it into `createMarkdownRenderer` via the
// `usePlugin` hook.

import texmath from 'markdown-it-texmath';

import type { MarkdownItInstance } from './createMarkdownRenderer';

export interface TexmathPluginOptions {
  /** Math engine (e.g. `katex`). */
  readonly engine: unknown;
  /** Engine-specific options (e.g. katex `{ throwOnError, macros, ... }`). */
  readonly engineOptions?: Record<string, unknown>;
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

/**
 * Returns a `usePlugin` hook that installs `markdown-it-texmath` with the
 * given engine + options. Pass into `createMarkdownRenderer({ usePlugin })`.
 */
export function createTexmathPlugin(
  options: TexmathPluginOptions,
): (md: MarkdownItInstance) => MarkdownItInstance {
  type TexmathFn = Parameters<MarkdownItInstance['use']>[0];
  return (md) => {
    const configured = md.use(texmath as unknown as TexmathFn, {
      engine: options.engine,
      delimiters: [...DELIMITERS],
      katexOptions: options.engineOptions,
    });
    addDisplayMathParagraphInterruptions(configured);
    return configured;
  };
}
