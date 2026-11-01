/**
 * The one hljs call the repo makes: highlighted HTML spans for `code` in
 * `lang`, or `null` when there is nothing to highlight — an unknown/absent
 * language, or a renderer that threw (surfaced, so a throwing renderer is not
 * indistinguishable from an unknown-language case). Each caller owns its own
 * wrapper: this file's {@link highlightCode} for markdown-it, which needs the
 * `<pre>` markdown-it would otherwise add, and the progress view for its code
 * blocks.
 */

import { hljs } from './hljs';

/** Sanitize lang for safe HTML attribute insertion (defense-in-depth;
 *  hljs.getLanguage() below already restricts to registered names). */
function safeLangFor(lang: string): string {
  return lang.replaceAll(/[^a-zA-Z0-9_-]/g, '');
}

export function highlightSpans(code: string, lang: string): string | null {
  if (!lang || !hljs.getLanguage(lang)) return null;
  try {
    return hljs.highlight(code, {
      language: lang,
      ignoreIllegals: true,
    }).value;
  } catch (error) {
    console.warn(
      `[highlightCode] highlight.js failed for language "${lang}":`,
      error,
    );
    return null;
  }
}

export function highlightCode(code: string, lang: string): string {
  const html = highlightSpans(code, lang);
  if (html === null) {
    // Return empty string — markdown-it will escape and wrap in its own <pre><code>
    return '';
  }
  // Return full <pre> so markdown-it uses it as-is (detects leading <pre)
  return `<pre class="hljs"><code class="language-${safeLangFor(lang)}">${html}</code></pre>`;
}
