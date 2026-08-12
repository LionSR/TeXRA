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

/** A single-message ChatExportInput fixture wrapping the given content blocks. */
function assistantChatInput(content: unknown[]): ChatExportInput {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    config: {},
    messages: [{ role: 'assistant', content }],
  };
}

/** A `web_search_tool_result` block wrapping the given result entries. */
function webSearchBlock(
  ...results: { title: string; url: string }[]
): Record<string, unknown> {
  return {
    type: 'web_search_tool_result',
    content: results.map((result) => ({
      type: 'web_search_result',
      ...result,
    })),
  };
}

/** A `web_fetch_tool_result` block in the archived flat shape. */
function webFetchBlock(fields: {
  url: string;
  title: string;
  page_content: string;
}): Record<string, unknown> {
  return { type: 'web_fetch_tool_result', ...fields };
}

describe('chat export formatters', () => {
  it('preserves function tool calls in mixed tool_calls arrays', () => {
    const markdown = formatChatAsMarkdown({
      timestamp: '2026-01-01T00:00:00.000Z',
      config: {},
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_first',
              type: 'function',
              function: {
                name: 'first_tool',
                arguments: '{"x":1}',
              },
            },
            {
              id: 'call_custom',
              type: 'custom',
              custom: {
                name: 'custom_tool',
                input: '{"skip":true}',
              },
            },
            {
              id: 'call_malformed',
              type: 'function',
            },
            {
              id: 'call_second',
              type: 'function',
              function: {
                name: 'second_tool',
                arguments: '{"y":2}',
              },
            },
          ],
        },
      ],
    });

    assert.match(markdown, /#### Tool: `first_tool`/);
    assert.match(markdown, /#### Tool: `second_tool`/);
    assert.doesNotMatch(markdown, /custom_tool/);
    assert.doesNotMatch(markdown, /call_malformed/);
  });

  it('renders OpenAI Responses function call outputs with mixed parts', () => {
    const markdown = formatChatAsMarkdown({
      timestamp: '2026-01-01T00:00:00.000Z',
      config: {},
      messages: [
        {
          type: 'function_call',
          name: 'fetch_notes',
          arguments: '{"topic":"sdk"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: [
            { type: 'input_text', text: 'first line' },
            { type: 'input_text', text: '' },
            { type: 'input_image', image_url: 'https://example.com/image.png' },
            { type: 'input_file', file_id: 'file_123' },
          ],
        },
      ],
    });

    assert.match(markdown, /#### Tool: `fetch_notes`/);
    assert.match(
      markdown,
      /```\nfirst line\n\n\[image attachment]\n\[file attachment]\n```/,
    );
  });

  it.each([
    {
      shape: 'live Anthropic nested',
      block: {
        type: 'web_fetch_tool_result',
        content: {
          type: 'web_fetch_result',
          url: 'https://example.com/live-export',
          content: {
            type: 'document',
            title: 'Live Export',
            source: {
              type: 'text',
              media_type: 'text/plain',
              data: 'Live export content',
            },
          },
        },
      },
      url: 'https://example.com/live-export',
      title: 'Live Export',
      content: 'Live export content',
    },
    {
      shape: 'archived flat',
      block: webFetchBlock({
        url: 'https://example.com/archived-export',
        title: 'Archived Export',
        page_content: 'Archived export content',
      }),
      url: 'https://example.com/archived-export',
      title: 'Archived Export',
      content: 'Archived export content',
    },
  ])(
    'renders $shape web-fetch fields in Markdown and LaTeX exports',
    ({ block, url, title, content }) => {
      const input = assistantChatInput([block]);

      const markdown = formatChatAsMarkdown(input);
      assert.ok(markdown.includes(`**URL:** ${url}`));
      assert.ok(markdown.includes(`**Title:** ${title}`));
      assert.ok(markdown.includes(content));

      const latex = formatChatAsLatex(input, '');
      assert.ok(latex.includes(`\\textbf{URL:} \\url{${url}}`));
      assert.ok(latex.includes(`\\textbf{Title:} ${title}`));
      assert.ok(latex.includes(content));
    },
  );

  it('sanitizes web tool URLs before rendering Markdown links', () => {
    const markdown = formatChatAsMarkdown(
      assistantChatInput([
        webSearchBlock(
          { title: 'unsafe result', url: 'javascript:alert(1)' },
          {
            title: 'safe result',
            url: '  https://example.com/search?q=texra  ',
          },
        ),
        webFetchBlock({
          url: 'data:text/html,<script>alert(1)</script>',
          title: 'unsafe fetch',
          page_content: 'body',
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
      assistantChatInput([
        webSearchBlock({
          title: 'safe ](javascript:alert(1)) [again',
          url: 'https://example.com/search',
        }),
        webFetchBlock({
          url: 'https://example.com/fetch',
          title: '[pwn](javascript:alert(1))',
          page_content: 'body',
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
      assistantChatInput([
        webSearchBlock({ title: 'safe result', url }),
        webFetchBlock({ url, title: 'safe fetch', page_content: 'body' }),
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
      block: webSearchBlock({ title: RAW_TITLE, url: 'https://example.com' }),
      expected: ESCAPED_TITLE,
    },
    {
      // Same escapeMarkdownText call, but through the web_fetch **Title:**
      // container (markdownSpec.ts's second call site).
      container: 'web-fetch **Title:**',
      block: webFetchBlock({
        url: 'https://example.com',
        title: RAW_TITLE,
        page_content: 'body',
      }),
      expected: `**Title:** ${ESCAPED_TITLE}`,
    },
  ])(
    'escapes emphasis/code-span/heading characters in $container titles',
    ({ block, expected }) => {
      const markdown = formatChatAsMarkdown(assistantChatInput([block]));

      assert.ok(
        markdown.includes(expected),
        `expected escaped title, got: ${markdown}`,
      );
    },
  );

  it('preserves IPv6 host brackets in Markdown link destinations', () => {
    const url = 'http://[::1]:8080/path';
    const markdown = formatChatAsMarkdown(
      assistantChatInput([webSearchBlock({ title: 'ipv6', url })]),
    );

    assert.ok(
      markdown.includes('- [ipv6](http://[::1]:8080/path)'),
      `expected IPv6 brackets preserved, got: ${markdown}`,
    );
  });

  it('sanitizes web tool URLs before rendering LaTeX links', () => {
    const latex = formatChatAsLatex(
      assistantChatInput([
        webSearchBlock(
          { title: 'unsafe result', url: 'vbscript:msgbox(1)' },
          { title: 'safe result', url: 'https://example.com/path#frag' },
        ),
        webFetchBlock({
          url: 'file:///etc/passwd',
          title: 'unsafe fetch',
          page_content: 'body',
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
      assistantChatInput([
        webSearchBlock({ title: 'safe result', url }),
        webFetchBlock({ url, title: 'safe fetch', page_content: 'body' }),
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
