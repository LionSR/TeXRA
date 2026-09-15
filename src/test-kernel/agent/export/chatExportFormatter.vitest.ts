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

describe('chat export formatters', () => {
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
      ]),
    );

    assert.match(markdown, /- unsafe result/);
    assert.match(
      markdown,
      /- \[safe result]\(https:\/\/example\.com\/search\?q=texra\)/,
    );
    assert.doesNotMatch(markdown, /javascript:alert/);
  });

  it('escapes Markdown syntax in web tool titles before rendering Markdown links', () => {
    const markdown = formatChatAsMarkdown(
      chatInput([
        webSearchResults({
          title: 'safe ](javascript:alert(1)) [again',
          url: 'https://example.com/search',
        }),
      ]),
    );

    assert.ok(
      markdown.includes(
        '- [safe \\]\\(javascript:alert\\(1\\)\\) \\[again](https://example.com/search)',
      ),
    );
    assert.doesNotMatch(markdown, /\]\(javascript:/);
  });

  it('escapes allowed-scheme URLs before rendering Markdown URL containers', () => {
    const url = 'https://example.com/a) [pwn](javascript:alert(1))';
    const markdown = formatChatAsMarkdown(
      chatInput([webSearchResults({ title: 'safe result', url })]),
    );

    assert.ok(
      markdown.includes(
        '- [safe result](https://example.com/a%29%20[pwn]%28javascript:alert%281%29%29)',
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
      ]),
      '',
    );

    assert.match(latex, /\\item unsafe result/);
    assert.match(
      latex,
      /\\item \\href\{https:\/\/example\.com\/path\\#frag\}\{safe result\}/,
    );
    assert.doesNotMatch(latex, /vbscript:msgbox/);
  });

  it('escapes allowed-scheme URLs before rendering LaTeX URL commands', () => {
    const url = String.raw`https://e.test/}\input{/etc/passwd`;
    const latex = formatChatAsLatex(
      chatInput([webSearchResults({ title: 'safe result', url })]),
      '',
    );

    assert.match(
      latex,
      /\\item \\href\{https:\/\/e\.test\/\\%7D\\%5Cinput\\%7B\/etc\/passwd\}\{safe result\}/,
    );
    assert.doesNotMatch(latex, /\\input/);
  });
});
