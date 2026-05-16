/**
 * Markdown rendering for the progress view.
 *
 * Thin webview-side adapter around the shared `@shared/markdown` factory:
 * registers the KaTeX math engine + project macros and the existing
 * `highlightCode` hljs hook, then exposes the legacy `getMarkdownRenderer` /
 * `processMarkdownContent` API the rest of the webview already imports.
 */

import katex from 'katex';

import { highlightCode } from '@shared/highlighting/highlightCode';
import {
  createMarkdownProcessor,
  createMarkdownRenderer,
  type MarkdownItInstance,
} from '@shared/markdown';

import { katexMacros } from '../katexMacros';

let cachedRenderer: MarkdownItInstance | null = null;
let cachedProcess: ((content: string) => string) | null = null;

function ensureInitialised(): {
  renderer: MarkdownItInstance;
  process: (content: string) => string;
} {
  if (!cachedRenderer || !cachedProcess) {
    cachedRenderer = createMarkdownRenderer({
      highlight: highlightCode,
      math: {
        engine: katex,
        engineOptions: {
          throwOnError: false,
          errorColor: 'var(--color-error, #cc0000)',
          macros: katexMacros,
        },
      },
    });
    cachedProcess = createMarkdownProcessor({ renderer: cachedRenderer });
  }
  return { renderer: cachedRenderer, process: cachedProcess };
}

/** Get the shared markdown renderer instance. */
export const getMarkdownRenderer = (): MarkdownItInstance =>
  ensureInitialised().renderer;

/** Process markdown content with LaTeX reference protection. */
export const processMarkdownContent = (
  content: string,
  renderer?: MarkdownItInstance,
): string => {
  if (!renderer) return ensureInitialised().process(content);
  // Custom renderer escape hatch (existing callers occasionally supply
  // bespoke instances — bypass the cached processor so we don't mix output
  // shapes inside the same memoiser).
  const process = createMarkdownProcessor({ renderer, disableCache: true });
  return process(content);
};
