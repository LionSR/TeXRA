import { beforeEach, describe, expect, it } from 'vitest';

import {
  InlineCommentTool,
  setInlineCommentProvider,
  type InlineCommentProvider,
} from '@tools/comment/InlineCommentTool';

/** Minimal in-memory provider. */
function fakeProvider(
  overrides: Partial<InlineCommentProvider> = {},
): InlineCommentProvider {
  return {
    add: () => ({ threadId: 'c1', resolvedPath: '/abs/paper.tex' }),
    reply: () => true,
    setResolved: () => true,
    list: () => [],
    ...overrides,
  };
}

const tool = new InlineCommentTool();

describe('InlineCommentTool.call', () => {
  beforeEach(() => setInlineCommentProvider(fakeProvider()));

  it('validates required fields for add', async () => {
    const result = await tool.call({ command: 'add', path: 'p.tex', line: 3 });
    expect(result.status).toBe('error');
    // The discriminated-union schema now rejects a missing `body` up front.
    expect(result.error).toContain('Invalid input');
    expect(result.error).toContain('body');
  });

  it('reports a missing thread on reply', async () => {
    setInlineCommentProvider(fakeProvider({ reply: () => false }));
    const result = await tool.call({
      command: 'reply',
      threadId: 'c9',
      body: 'hi',
    });
    expect(result.summary).toBe('Thread not found');
  });

  it('lists threads via the provider, rendering each range and state', async () => {
    setInlineCommentProvider(
      fakeProvider({
        list: () => [
          {
            threadId: 'c1',
            path: '/abs/paper.tex',
            line: 2,
            endLine: 2,
            resolved: false,
            comments: [
              { author: 'TeXRA', body: 'reword' },
              { author: 'You', body: 'done' },
            ],
          },
          {
            threadId: 'c2',
            path: '/abs/paper.tex',
            line: 5,
            endLine: 9,
            resolved: true,
            comments: [{ author: 'TeXRA', body: 'see below' }],
          },
        ],
      }),
    );
    const result = await tool.call({ command: 'list' });
    expect(result.summary).toBe('2 comment threads');
    expect(result.output).toBe(
      '[c1] /abs/paper.tex:2 (open)\n  TeXRA: reword\n  You: done\n\n' +
        '[c2] /abs/paper.tex:5-9 (resolved)\n  TeXRA: see below',
    );
  });
});
