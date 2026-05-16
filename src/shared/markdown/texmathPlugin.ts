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

// `markdown-it-texmath` only defines `\[...\]` as a *block* rule out of the
// box; we want it inline too so the renderer is consistent across hosts.
// `texmath.rules.brackets.inline` is process-global, so guard with an
// idempotency flag.
let inlineRuleInstalled = false;
function ensureInlineDisplayRule(): void {
  if (inlineRuleInstalled) return;
  texmath.rules.brackets.inline.push({
    name: 'math_inline_display',
    rex: /\\\[([\s\S]+?)\\\]/gy,
    tmpl: '<section><eqn>$1</eqn></section>',
    tag: '\\[',
    displayMode: true,
  });
  inlineRuleInstalled = true;
}

/**
 * Returns a `usePlugin` hook that installs `markdown-it-texmath` with the
 * given engine + options. Pass into `createMarkdownRenderer({ usePlugin })`.
 */
export function createTexmathPlugin(
  options: TexmathPluginOptions,
): (md: MarkdownItInstance) => MarkdownItInstance {
  ensureInlineDisplayRule();
  type TexmathFn = Parameters<MarkdownItInstance['use']>[0];
  return (md) =>
    md.use(texmath as unknown as TexmathFn, {
      engine: options.engine,
      delimiters: options.delimiters ?? ['dollars', 'brackets', 'beg_end'],
      katexOptions: options.engineOptions,
    });
}
