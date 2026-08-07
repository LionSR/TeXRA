/**
 * Markdown rendering for the progress view.
 *
 * Thin webview-side adapter around the shared KaTeX-enabled processor; only
 * the webview-specific error colour lives here.
 */

// Direct path import — see `src/shared/markdown/index.ts` for why this isn't
// re-exported through the barrel.
import { createKatexHtmlProcessor } from '@shared/markdown/katexHtmlProcessor';

let cachedProcess: ((content: string) => string) | null = null;

/** Process markdown content with LaTeX reference protection. */
export function processMarkdownContent(content: string): string {
  cachedProcess ??= createKatexHtmlProcessor({
    errorColor: 'var(--color-error)',
  });
  return cachedProcess(content);
}
