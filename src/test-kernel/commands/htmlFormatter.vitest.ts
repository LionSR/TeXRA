// Verifies that the HTML chat export renders markdown, code blocks, and
// LaTeX math through the shared markdown-it/KaTeX/highlight.js pipeline,
// wrapped in the Lit-SSR Declarative-Shadow-DOM components.

import { describe, expect, it } from 'vitest';

import { formatChatAsHtml } from '@commands/history/htmlExport/htmlFormatter';
import type { ChatExportInput } from '@commands/history/chatExportFormatter';

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

  it('wraps each message in a Lit custom element with declarative shadow DOM', () => {
    // SSR emits <texra-chat-message>/<texra-chat-tool-block> as the outer
    // custom element wrapping <template shadowrootmode="open"> that browsers
    // reify into a shadow root with no client-side JS required. The
    // `texra-` prefix + `data-*` attributes avoid the reserved ARIA `role`
    // attribute and reduce custom-element name collision risk.
    expect(html).toMatch(/<texra-chat-message[^>]*data-role="user"/);
    expect(html).toMatch(/<texra-chat-message[^>]*data-role="assistant"/);
    expect(html).toMatch(/<texra-chat-tool-block[^>]*data-kind="call"/);
    expect(html).toMatch(/<texra-chat-tool-block[^>]*data-kind="result"/);
    expect(html).toMatch(/<template[^>]*shadowrootmode="open"/);
  });

  it('inlines component-scoped CSS inside the declarative shadow root', () => {
    // Scoped styles should appear inside <style> inside the DSD template.
    // Token CSS variables (`--ce-bg-*`) are a tell that chatTokens applied.
    expect(html).toMatch(
      /<template[^>]*shadowrootmode="open">\s*<style>[\s\S]*--ce-bg/,
    );
  });

  it('escapes HTML in user input so injection is impossible', () => {
    const malicious = formatChatAsHtml({
      ...fixture,
      messages: [{ role: 'user', content: '<script>alert(1)</script>' }],
    });
    expect(malicious).not.toContain('<script>alert(1)</script>');
    expect(malicious).toContain('&lt;script&gt;');
  });

  it('labels web-search-results distinctly from generic tool results', () => {
    // A web_search_tool_result block must surface as "Web results", not
    // re-use the "Tool result" label. The IR is constructed from raw
    // Anthropic-style content blocks.
    const withWebResults = formatChatAsHtml({
      ...fixture,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'web_search_tool_result',
              content: [
                {
                  type: 'web_search_result',
                  url: 'https://en.wikipedia.org/wiki/Riemann_zeta_function',
                  title: 'Riemann zeta function — Wikipedia',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(withWebResults).toMatch(
      /<texra-chat-tool-block[^>]*data-kind="web-results"/,
    );
    expect(withWebResults).toContain('Web results');
  });

  it('strips dangerous URL schemes from tool-provided links', () => {
    // `web_search_result.url` and `web_fetch_tool_result.url` flow from
    // tool output and could carry `javascript:` (or `data:`) schemes that
    // would execute when the recipient clicks the link in a shared file.
    // The exporter renders those as non-clickable <code> instead.
    const malicious = formatChatAsHtml({
      ...fixture,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'web_search_tool_result',
              content: [
                {
                  type: 'web_search_result',
                  url: 'javascript:alert("xss")',
                  title: 'click me',
                },
              ],
            },
            {
              type: 'web_fetch_tool_result',
              url: 'data:text/html,<script>alert(1)</script>',
              title: 'evil',
              page_content: 'whatever',
            },
          ],
        },
      ],
    });
    expect(malicious).not.toContain('href="javascript:');
    expect(malicious).not.toContain('href="data:');
    // Should still surface the URL as text so reviewers can see what was
    // attempted, just not as a clickable anchor.
    expect(malicious).toContain('javascript:alert');
  });

  it('strips protocol-relative URLs from tool-provided links', () => {
    const malicious = formatChatAsHtml({
      ...fixture,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'web_search_tool_result',
              content: [
                {
                  type: 'web_search_result',
                  url: '//evil.example.com/path',
                  title: 'protocol-relative',
                },
              ],
            },
          ],
        },
      ],
    });

    expect(malicious).not.toContain('href="//evil.example.com/path"');
    expect(malicious).toContain('//evil.example.com/path');
  });
});
