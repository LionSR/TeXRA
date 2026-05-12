// Third-party imports
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

// Local imports - progress view
import { processMarkdownContent } from '@progressView/frontend/formatters/markdownRenderer';

describe('processMarkdownContent security', () => {
  it('escapes raw HTML before rendering markdown output', () => {
    const rendered = processMarkdownContent('<script>alert(1)</script>');
    const dom = new JSDOM(`<main>${rendered}</main>`);

    expect(dom.window.document.querySelector('script')).toBeNull();
    expect(dom.window.document.body.textContent).toContain(
      '<script>alert(1)</script>',
    );
  });

  it('escapes restored LaTeX reference labels before HTML insertion', () => {
    const label = 'bad" onclick="alert(1)<img src=x>';
    const rendered = processMarkdownContent(`See \\ref{${label}}.`);
    const dom = new JSDOM(`<main>${rendered}</main>`);
    const ref = dom.window.document.querySelector('.latex-ref');

    expect(ref).not.toBeNull();
    expect(ref?.getAttribute('onclick')).toBeNull();
    expect(ref?.getAttribute('data-label')).toBe(label);
    expect(ref?.textContent).toBe(`\\ref{${label}}`);
    expect(dom.window.document.querySelector('img')).toBeNull();
  });
});
