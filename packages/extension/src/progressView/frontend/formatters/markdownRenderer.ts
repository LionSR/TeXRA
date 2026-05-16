/**
 * Markdown rendering for the progress view.
 *
 * Thin webview-side adapter around the shared `@shared/markdown` factory:
 * registers the KaTeX math engine + project macros and the existing
 * `highlightCode` hljs hook, then exposes `processMarkdownContent` for the
 * rest of the webview.
 */

import katex from 'katex';

import {
  createMarkdownProcessor,
  createMarkdownRenderer,
} from '@shared/markdown';
import { highlightCode } from '@shared/highlighting/highlightCode';
// Direct path import — see `src/shared/markdown/index.ts` for why this isn't
// re-exported through the barrel.
import { createTexmathPlugin } from '@shared/markdown/texmathPlugin';

import { katexMacros } from '../katexMacros';

let cachedProcess: ((content: string) => string) | null = null;

function ensureInitialised(): (content: string) => string {
  if (!cachedProcess) {
    const renderer = createMarkdownRenderer({
      highlight: highlightCode,
      usePlugin: createTexmathPlugin({
        engine: katex,
        engineOptions: {
          throwOnError: false,
          errorColor: 'var(--color-error, #cc0000)',
          macros: katexMacros,
        },
      }),
    });
    cachedProcess = createMarkdownProcessor({ renderer });
  }
  return cachedProcess;
}

/** Process markdown content with LaTeX reference protection. */
export const processMarkdownContent = (content: string): string =>
  ensureInitialised()(content);
