/**
 * Markdown rendering for the progress view.
 *
 * Caches one instance of the shared KaTeX-enabled processor.
 */

import { createKatexHtmlProcessor } from '@ui/markdown/katexHtmlProcessor';

let cachedProcess: ((content: string) => string) | null = null;

/** Render markdown (with KaTeX math) to HTML, protecting LaTeX references. */
export function renderMarkdownHtml(content: string): string {
  cachedProcess ??= createKatexHtmlProcessor();
  return cachedProcess(content);
}
