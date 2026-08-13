import { beforeEach, describe, expect, it } from 'vitest';

import {
  InlineCommentInputSchema,
  InlineCommentTool,
  setInlineCommentProvider,
  type InlineCommentProvider,
} from '@tools/comment/InlineCommentTool';

/** Minimal in-memory provider. */
function fakeProvider(
  overrides: Partial<InlineCommentProvider> = {},
): InlineCommentProvider {
  return {
    available: () => true,
    add: () => ({ threadId: 'c1', resolvedPath: '/abs/paper.tex' }),
    reply: () => true,
    setResolved: () => true,
    list: () => [],
    ...overrides,
  };
}

const tool = new InlineCommentTool();

describe('InlineCommentInputSchema', () => {
  it('accepts a valid add command and rejects unknown keys', () => {
    expect(
      InlineCommentInputSchema.parse({
        command: 'add',
        path: 'paper.tex',
        line: 12,
        body: 'tighten this claim',
      }).command,
    ).toBe('add');

    expect(() =>
      InlineCommentInputSchema.parse({
        command: 'list',
        unexpected: true,
      }),
    ).toThrow();
  });

  it('rejects empty body and non-positive lines', () => {
    expect(() =>
      InlineCommentInputSchema.parse({
        command: 'add',
        path: 'p.tex',
        line: 1,
        body: '',
      }),
    ).toThrow();
    expect(() =>
      InlineCommentInputSchema.parse({
        command: 'add',
        path: 'p.tex',
        line: 0,
        body: 'x',
      }),
    ).toThrow();
  });
});

describe('InlineCommentTool.call', () => {
  beforeEach(() => setInlineCommentProvider(fakeProvider()));

  it('reports unavailable when no host provider is wired', async () => {
    setInlineCommentProvider(fakeProvider({ available: () => false }));
    const result = await tool.call({ command: 'list' });
    expect(result.summary).toBe('Inline comments unavailable');
    expect(result.status).toBe('executed');
  });

  it('validates required fields for add', async () => {
    const result = await tool.call({ command: 'add', path: 'p.tex', line: 3 });
    expect(result.status).toBe('error');
    expect(result.error).toContain('requires path, line, and body');
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
