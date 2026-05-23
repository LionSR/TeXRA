// Verifies that the HTML chat export renders markdown, code blocks, and
// LaTeX math through the shared markdown-it/KaTeX/highlight.js pipeline.
//
// `htmlFormatter.ts` lives under `packages/extension/src/commands/history/`
// (vsce-only); we import it here through its repo-relative path because the
// alias map doesn't cover the extension package.

import { describe, expect, it } from 'vitest';

import { formatChatAsHtml } from '../../../packages/extension/src/commands/history/htmlExport/htmlFormatter';
import type { ChatExportInput } from '../../../packages/extension/src/commands/history/chatExportFormatter';

const fixture: ChatExportInput = {
  timestamp: '2026-05-23T10:00:00.000Z',
  description: 'Plot the Riemann zeta zeros',
  config: {
    agent: 'workflow.research',
    model: 'claude-opus-4-7',
    instruction: 'Walk me through the Riemann hypothesis.',
    inputFiles: ['notes.tex'],
  },
  messages: [
    {
      role: 'user',
      content: 'Please summarise.',
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text:
            'Here is a quick recap.\n\n' +
            'The Riemann zeta function is $\\zeta(s) = \\sum_{n=1}^{\\infty} n^{-s}$.\n\n' +
            '```python\nimport mpmath\nmpmath.zetazero(1)\n```\n',
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'run_python',
          input: { script: "print('hi')" },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: 'hi\n',
        },
      ],
    },
  ],
};

describe('formatChatAsHtml', () => {
  const html = formatChatAsHtml(fixture);

  it('produces a complete HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    expect(html).toContain('<title>Plot the Riemann zeta zeros</title>');
  });

  it('links to the assets folder for CSS and fonts', () => {
    expect(html).toContain('href="./assets/katex.min.css"');
    expect(html).toContain('href="./assets/chat.css"');
    expect(html).toContain('href="./assets/hljs-light.css"');
    expect(html).toContain('href="./assets/hljs-dark.css"');
  });

  it('renders the document header with run metadata', () => {
    expect(html).toContain('workflow.research');
    expect(html).toContain('claude-opus-4-7');
    expect(html).toContain('Walk me through the Riemann hypothesis.');
    expect(html).toContain('notes.tex');
  });

  it('renders KaTeX math via texmath plugin', () => {
    // KaTeX wraps inline math in span.katex; texmath wraps display blocks in
    // <section><eqn>. Either is sufficient evidence the plugin ran.
    expect(html).toMatch(/class="katex/);
  });

  it('highlights python code via highlight.js', () => {
    expect(html).toContain('language-python');
    expect(html).toContain('hljs-keyword');
  });

  it('renders tool calls and tool results as distinct sections', () => {
    expect(html).toContain('Tool call');
    expect(html).toContain('run_python');
    expect(html).toContain('Tool result');
  });

  it('escapes HTML in user input so injection is impossible', () => {
    const malicious = formatChatAsHtml({
      ...fixture,
      messages: [{ role: 'user', content: '<script>alert(1)</script>' }],
    });
    expect(malicious).not.toContain('<script>alert(1)</script>');
    expect(malicious).toContain('&lt;script&gt;');
  });
});
