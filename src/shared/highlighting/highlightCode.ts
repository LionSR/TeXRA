/**
 * Custom highlight function for markdown-it using optimized hljs.
 * Returns a full <pre class="hljs"> wrapper so markdown-it uses it directly
 * (skipping its default wrapper), ensuring hljs CSS rules apply.
 * Falls back to empty string for unknown languages (markdown-it escapes).
 */

import { hljs } from './hljs';

export function highlightCode(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      const highlighted = hljs.highlight(code, {
        language: lang,
        ignoreIllegals: true,
      }).value;
      // Sanitize lang for safe HTML attribute insertion (defense-in-depth;
      // hljs.getLanguage() above already restricts to registered names)
      const safeLang = lang.replaceAll(/[^a-zA-Z0-9_-]/g, '');
      // Return full <pre> so markdown-it uses it as-is (detects leading <pre)
      return `<pre class="hljs"><code class="language-${safeLang}">${highlighted}</code></pre>`;
    } catch (error) {
      // Fall through to plain text, but surface genuine highlight failures so
      // a throwing renderer is not indistinguishable from an unknown-language
      // case.
      console.warn(`highlight.js failed for language "${lang}":`, error);
    }
  }
  // Return empty string — markdown-it will escape and wrap in its own <pre><code>
  return '';
}
