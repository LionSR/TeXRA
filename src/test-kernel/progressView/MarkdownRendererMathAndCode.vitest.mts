// Third-party imports
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// Local imports - progress view
import { processMarkdownContent } from '@progressView/frontend/formatters/markdownRenderer';

/**
 * Regression coverage for issue #7449: the trace-viewer-based HTML export
 * (`--export html` / the extension's "Export as HTML" button, since #7137)
 * replays a trace through the exact same progress-view Lit components the
 * live webview uses (`packages/trace-viewer/src/main.ts` imports
 * `@progressView/frontend`) — so `processMarkdownContent` is the single
 * shared rendering path for both hosts. Nothing here previously pinned that
 * KaTeX and highlight.js actually render (not just "don't crash") through
 * this path, so a regression here would only have surfaced via the manual,
 * uncommitted Playwright check described in #7137's commit message.
 */
function renderToDocument(markdown: string): Document {
  const rendered = processMarkdownContent(markdown);
  return new JSDOM(`<main>${rendered}</main>`).window.document;
}

describe('processMarkdownContent renders math and code (issue #7449)', () => {
  it('renders display math to a KaTeX element, not raw delimiters', () => {
    const doc = renderToDocument('$$E = mc^2 + \\int_0^1 f(x)\\,dx$$');

    const katex = doc.querySelector('.katex');
    expect(katex).not.toBeNull();
    expect(katex?.querySelector('annotation')?.textContent).toBe(
      'E = mc^2 + \\int_0^1 f(x)\\,dx',
    );
    expect(doc.body.textContent).not.toContain('$$');
  });

  it('renders inline math to a KaTeX element', () => {
    const doc = renderToDocument('The energy is $E = mc^2$ at rest.');

    expect(doc.querySelector('.katex')).not.toBeNull();
  });

  it('syntax-highlights a fenced code block instead of leaving it plain', () => {
    const doc = renderToDocument(
      [
        '```python',
        'def solve(x: int) -> int:',
        '    return x ** 2 + 1',
        '```',
      ].join('\n'),
    );

    const block = doc.querySelector('pre.hljs code.language-python');
    expect(block).not.toBeNull();
    expect(block?.querySelector('.hljs-keyword')).not.toBeNull();
    expect(block?.querySelector('.hljs-built_in')).not.toBeNull();
    expect(block?.textContent).toContain('def solve');
  });
});
