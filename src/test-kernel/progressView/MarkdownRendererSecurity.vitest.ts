// Third-party imports
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// Local imports - progress view
import { processMarkdownContent } from '@progressView/frontend/formatters/markdownRenderer';

function renderToDocument(markdown: string): Document {
  const rendered = processMarkdownContent(markdown);
  return new JSDOM(`<main>${rendered}</main>`).window.document;
}

describe('processMarkdownContent security', () => {
  it('escapes raw HTML before rendering markdown output', () => {
    const doc = renderToDocument('<script>alert(1)</script>');

    expect(doc.querySelector('script')).toBeNull();
    expect(doc.body.textContent).toContain('<script>alert(1)</script>');
  });

  it('escapes restored LaTeX reference labels before HTML insertion', () => {
    const label = 'bad" onclick="alert(1)<img src=x>';
    const doc = renderToDocument(`See \\ref{${label}}.`);
    const ref = doc.querySelector('.latex-ref');

    expect(ref).not.toBeNull();
    expect(ref?.getAttribute('onclick')).toBeNull();
    expect(ref?.getAttribute('data-label')).toBe(label);
    expect(ref?.getAttribute('role')).toBe('button');
    expect(ref?.getAttribute('tabindex')).toBe('0');
    expect(ref?.textContent).toBe(`\\ref{${label}}`);
    expect(doc.querySelector('img')).toBeNull();
  });
});
