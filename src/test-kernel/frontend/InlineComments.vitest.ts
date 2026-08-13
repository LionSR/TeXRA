import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createCommentThread: vi.fn(),
}));

vi.mock('vscode', () => ({
  CommentMode: { Preview: 0 },
  CommentThreadCollapsibleState: { Expanded: 1 },
  CommentThreadState: { Resolved: 1, Unresolved: 0 },
  MarkdownString: class {
    constructor(readonly value: string) {}
  },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  commands: { registerCommand: vi.fn(() => ({ dispose: vi.fn() })) },
  comments: {
    createCommentController: vi.fn(() => ({
      createCommentThread: mocks.createCommentThread,
      dispose: vi.fn(),
    })),
  },
}));

vi.mock('@frontend/vscode/vscodeEditor', () => ({
  lineToRange: vi.fn(() => ({ start: { line: 0 }, end: { line: 0 } })),
}));

vi.mock('@logger/logUtils', () => ({
  info: vi.fn(),
  createLog: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import {
  getInlineCommentProvider,
  registerInlineComments,
} from '@frontend/comments/inlineComments';

describe('inline comments', () => {
  afterEach(() => {
    mocks.createCommentThread.mockReset();
    vi.restoreAllMocks();
  });

  it('matches Windows paths case-insensitively when listing threads', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    mocks.createCommentThread.mockImplementation((uri, range, comments) => ({
      uri,
      range,
      comments,
      dispose: vi.fn(),
    }));
    const subscriptions: Array<{ dispose(): void }> = [];
    registerInlineComments({ subscriptions } as never);
    const provider = getInlineCommentProvider();

    provider.add({
      absolutePath: 'C:\\work\\paper.tex',
      line: 1,
      endLine: 1,
      body: 'Check this claim.',
    });

    expect(provider.list({ absolutePath: 'C:\\WORK\\PAPER.tex' })).toHaveLength(
      1,
    );
  });
});
