// `markdown-it-texmath` wiring lives in its own module so non-math hosts
// (the CLI TUI) don't pull texmath into their bundle. The webview imports
// `createTexmathPlugin` and threads it into `createMarkdownRenderer` via the
// `usePlugin` hook.

import texmath from 'markdown-it-texmath';

import type { MarkdownItInstance } from './createMarkdownRenderer';

export interface TexmathPluginOptions {
  /** Math engine (e.g. `katex`). */
  readonly engine: unknown;
  /** Delimiters argument forwarded to texmath. */
  readonly delimiters?: ReadonlyArray<string>;
  /** Engine-specific options (e.g. katex `{ throwOnError, macros, ... }`). */
  readonly engineOptions?: Record<string, unknown>;
}

const PARAGRAPH_INTERRUPTION_CHAINS = Object.freeze([
  'paragraph',
  'reference',
  'blockquote',
  'list',
]);

/** Allow configured display-math rules to interrupt an adjacent paragraph. */
function addDisplayMathParagraphInterruptions(
  md: MarkdownItInstance,
  delimiters: ReadonlyArray<string>,
): void {
  const blockRules = [
    ...(delimiters.includes('dollars') ? texmath.rules.dollars.block : []),
    ...(delimiters.includes('brackets') ? texmath.rules.brackets.block : []),
    ...(delimiters.includes('beg_end') ? texmath.rules.beg_end.block : []),
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
  const delimiters = options.delimiters ?? ['dollars', 'brackets', 'beg_end'];
  type TexmathFn = Parameters<MarkdownItInstance['use']>[0];
  return (md) => {
    const configured = md.use(texmath as unknown as TexmathFn, {
      engine: options.engine,
      delimiters,
      katexOptions: options.engineOptions,
    });
    addDisplayMathParagraphInterruptions(configured, delimiters);
    return configured;
  };
}
