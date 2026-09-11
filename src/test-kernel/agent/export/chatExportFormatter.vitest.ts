// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports - host-neutral chat-export formatters
import {
  formatChatAsLatex,
  formatChatAsMarkdown,
  type ChatExportInput,
} from '@agent/export/chatExportFormatter';
import type { ExportNode } from '@agent/export/schemas';

/** A ChatExportInput fixture wrapping the given conversation nodes. */
function chatInput(nodes: ExportNode[]): ChatExportInput {
  return { timestamp: '2026-01-01T00:00:00.000Z', config: {}, nodes };
}

/** A web-search result-list node. */
function webSearchResults(
  ...results: { title: string; url: string }[]
): ExportNode {
  return { kind: 'web-search-results', results };
}

/** A web-fetch node. */
function webFetch(fields: {
  url: string;
  title: string;
  content: string;
}): ExportNode {
  return { kind: 'web-fetch', ...fields };
}

describe('chat export formatters', () => {
  it('renders web-fetch fields in Markdown and LaTeX exports', () => {
    const url = 'https://example.com/export';
    const input = chatInput([
      webFetch({ url, title: 'Export', content: 'Export content' }),
    ]);

    const markdown = formatChatAsMarkdown(input);
    assert.ok(markdown.includes(`**URL:** ${url}`));
    assert.ok(markdown.includes('**Title:** Export'));
    assert.ok(markdown.includes('Export content'));

    const latex = formatChatAsLatex(input, '');
    assert.ok(latex.includes(`\\textbf{URL:} \\url{${url}}`));
    assert.ok(latex.includes('\\textbf{Title:} Export'));
    assert.ok(latex.includes('Export content'));
  });

  it('sanitizes web tool URLs before rendering Markdown links', () => {
    const markdown = formatChatAsMarkdown(
      chatInput([
        webSearchResults(
          { title: 'unsafe result', url: 'javascript:alert(1)' },
          {
            title: 'safe result',
            url: '  https://example.com/search?q=texra  ',
          },
        ),
        webFetch({
          url: 'data:text/html,<script>alert(1)</script>',
          title: 'unsafe fetch',
          content: 'body',
        }),
      ]),
    );

    assert.match(markdown, /- unsafe result/);
    assert.match(
      markdown,
      /- \[safe result]\(https:\/\/example\.com\/search\?q=texra\)/,
    );
    assert.match(markdown, /\*\*Title:\*\* unsafe fetch/);
    assert.doesNotMatch(markdown, /javascript:alert/);
    assert.doesNotMatch(markdown, /data:text\/html/);
  });

  it('escapes Markdown syntax in web tool titles before rendering Markdown links', () => {
    const markdown = formatChatAsMarkdown(
      chatInput([
        webSearchResults({
          title: 'safe ](javascript:alert(1)) [again',
          url: 'https://example.com/search',
        }),
        webFetch({
          url: 'https://example.com/fetch',
          title: '[pwn](javascript:alert(1))',
          content: 'body',
        }),
      ]),
    );

    assert.ok(
      markdown.includes(
        '- [safe \\]\\(javascript:alert\\(1\\)\\) \\[again](https://example.com/search)',
      ),
    );
    assert.ok(
      markdown.includes('**Title:** \\[pwn\\]\\(javascript:alert\\(1\\)\\)'),
    );
    assert.doesNotMatch(markdown, /\]\(javascript:/);
  });

  it('escapes allowed-scheme URLs before rendering Markdown URL containers', () => {
    const url = 'https://example.com/a) [pwn](javascript:alert(1))';
    const markdown = formatChatAsMarkdown(
      chatInput([
        webSearchResults({ title: 'safe result', url }),
        webFetch({ url, title: 'safe fetch', content: 'body' }),
      ]),
    );

    assert.ok(
      markdown.includes(
        '- [safe result](https://example.com/a%29%20[pwn]%28javascript:alert%281%29%29)',
      ),
    );
    assert.ok(
      markdown.includes(
        '**URL:** https://example.com/a\\) \\[pwn\\]\\(javascript:alert\\(1\\)\\)',
      ),
    );
    assert.doesNotMatch(markdown, /\]\(javascript:/);
  });

  const RAW_TITLE = '`rm -rf /` *bold* _italic_ # Heading';
  const ESCAPED_TITLE = '\\`rm -rf /\\` \\*bold\\* \\_italic\\_ \\# Heading';

  it.each([
    {
      container: 'web search result link',
      block: webSearchResults({ title: RAW_TITLE, url: 'https://example.com' }),
      expected: ESCAPED_TITLE,
    },
    {
      // Same escapeMarkdownText call, but through the web_fetch **Title:**
      // container (markdownSpec.ts's second call site).
      container: 'web-fetch **Title:**',
      block: webFetch({
        url: 'https://example.com',
        title: RAW_TITLE,
        content: 'body',
      }),
      expected: `**Title:** ${ESCAPED_TITLE}`,
    },
  ])(
    'escapes emphasis/code-span/heading characters in $container titles',
    ({ block, expected }) => {
      const markdown = formatChatAsMarkdown(chatInput([block]));

      assert.ok(
        markdown.includes(expected),
        `expected escaped title, got: ${markdown}`,
      );
    },
  );

  it('preserves IPv6 host brackets in Markdown link destinations', () => {
    const url = 'http://[::1]:8080/path';
    const markdown = formatChatAsMarkdown(
      chatInput([webSearchResults({ title: 'ipv6', url })]),
    );

    assert.ok(
      markdown.includes('- [ipv6](http://[::1]:8080/path)'),
      `expected IPv6 brackets preserved, got: ${markdown}`,
    );
  });

  it('sanitizes web tool URLs before rendering LaTeX links', () => {
    const latex = formatChatAsLatex(
      chatInput([
        webSearchResults(
          { title: 'unsafe result', url: 'vbscript:msgbox(1)' },
          { title: 'safe result', url: 'https://example.com/path#frag' },
        ),
        webFetch({
          url: 'file:///etc/passwd',
          title: 'unsafe fetch',
          content: 'body',
        }),
      ]),
      '',
    );

    assert.match(latex, /\\item unsafe result/);
    assert.match(
      latex,
      /\\item \\href\{https:\/\/example\.com\/path\\#frag\}\{safe result\}/,
    );
    assert.match(latex, /\\textbf\{Title:\} unsafe fetch/);
    assert.doesNotMatch(latex, /vbscript:msgbox/);
    assert.doesNotMatch(latex, /file:\/\/\/etc\/passwd/);
  });

  it('escapes allowed-scheme URLs before rendering LaTeX URL commands', () => {
    const url = String.raw`https://e.test/}\input{/etc/passwd`;
    const latex = formatChatAsLatex(
      chatInput([
        webSearchResults({ title: 'safe result', url }),
        webFetch({ url, title: 'safe fetch', content: 'body' }),
      ]),
      '',
    );

    assert.match(
      latex,
      /\\item \\href\{https:\/\/e\.test\/\\%7D\\%5Cinput\\%7B\/etc\/passwd\}\{safe result\}/,
    );
    assert.match(
      latex,
      /\\textbf\{URL:\} \\url\{https:\/\/e\.test\/\\%7D\\%5Cinput\\%7B\/etc\/passwd\}/,
    );
    assert.doesNotMatch(latex, /\\input/);
  });
});
