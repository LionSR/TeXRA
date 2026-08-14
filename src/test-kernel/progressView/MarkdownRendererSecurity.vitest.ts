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

  it('does not replace user text resembling a LaTeX reference placeholder', () => {
    const doc = renderToDocument('literal @@LATEX-REF-0@@ and \\ref{actual}');

    expect(doc.body.textContent).toContain('literal @@LATEX-REF-0@@ and');
    expect(doc.querySelector('.latex-ref')?.textContent).toBe('\\ref{actual}');
  });
});

// Regression coverage for #7449 — see PR description for the trace-viewer
// export parity verification this pins.
describe('processMarkdownContent renders math and code', () => {
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

  const CRITERION_FORMULA =
    'c_{\\alpha\\beta}^{\\gamma}(L)=\\operatorname{Tr}(\\chi^L).';

  it.each([
    {
      context: 'prose',
      markdown: [
        'The coefficient is',
        '\\[',
        CRITERION_FORMULA,
        '\\]',
        'The next paragraph follows.',
      ].join('\n'),
    },
    {
      context: 'a heading',
      markdown: [
        '### Exact criterion',
        '\\[',
        CRITERION_FORMULA,
        '\\]',
        'The next paragraph follows.',
      ].join('\n'),
    },
    {
      context: 'a list item',
      markdown: [
        '- The coefficient is',
        '  \\[',
        `  ${CRITERION_FORMULA}`,
        '  \\]',
        '  The next paragraph follows.',
      ].join('\n'),
    },
    {
      context: 'a block quotation',
      markdown: [
        '> The coefficient is',
        '> \\[',
        `> ${CRITERION_FORMULA}`,
        '> \\]',
        '> The next paragraph follows.',
      ].join('\n'),
    },
  ])(
    'renders bracketed display math immediately after $context',
    ({ markdown }) => {
      const doc = renderToDocument(markdown);
      const displayMath = doc.querySelector('.katex-display');

      expect(displayMath).not.toBeNull();
      expect(displayMath?.querySelector('annotation')?.textContent).toContain(
        'c_{\\alpha\\beta}^{\\gamma}(L)',
      );
      expect(doc.body.textContent).not.toContain('\\[');
      expect(doc.body.textContent).not.toContain('\\]');
    },
  );

  it('keeps adjacent prose in separate paragraphs around display math', () => {
    const rendered = processMarkdownContent(
      ['Before', '\\[', 'x^2', '\\]', 'After'].join('\n'),
    );

    expect(rendered).toMatch(/^<p>Before<\/p>\n<section>/);
    expect(rendered).toMatch(/<\/section><p>After<\/p>\n$/);
  });

  it('renders dollar display math immediately after prose', () => {
    const doc = renderToDocument(
      ['The coefficient is', '$$c(L)=1+\\lambda^L$$', 'Exactly.'].join('\n'),
    );

    expect(doc.querySelector('.katex-display')).not.toBeNull();
    expect(doc.body.textContent).not.toContain('$$');
  });

  it('leaves display-math delimiters literal inside fenced code', () => {
    const doc = renderToDocument(
      ['```tex', '\\[', 'x^2', '\\]', '```'].join('\n'),
    );

    expect(doc.querySelector('.katex')).toBeNull();
    expect(doc.querySelector('code')?.textContent).toContain('\\[\nx^2\n\\]');
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
