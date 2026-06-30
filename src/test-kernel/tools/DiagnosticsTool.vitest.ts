import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import {
  DiagnosticsTool,
  setAddCriticismSink,
  setLinterProvider,
} from '@tools/DiagnosticsTool';

afterEach(() => {
  setLinterProvider(async () => []);
  setAddCriticismSink(() => ({ accepted: false, resolvedPath: '' }));
});

function worktreeContext() {
  return createRunContext({
    runtimeHost: { emit: vi.fn() },
    workingDirectory: '/worktree',
  });
}

describe('DiagnosticsTool', () => {
  it('reads diagnostics from the active working directory root', async () => {
    const paths: string[] = [];
    setLinterProvider(async (path) => {
      paths.push(path);
      return [];
    });
    const result = await withRunContext(worktreeContext(), () =>
      new DiagnosticsTool().call({ command: 'list', path: 'paper.tex' }),
    );

    expect(paths).toEqual(['/worktree/paper.tex']);
    expect(result.diagnostics).toMatchObject({
      path: '/worktree/paper.tex',
      command: 'list',
    });
  });

  it('rejects an add command missing required fields', async () => {
    const result = await new DiagnosticsTool().call({
      command: 'add',
      path: 'paper.tex',
    });

    expect(result.isError).toBe(true);
    expect(result.error).toContain(
      'requires line, message, severity, and confidence',
    );
  });

  it('reports when the criticism sink does not accept (feature disabled)', async () => {
    setAddCriticismSink(() => ({ accepted: false, resolvedPath: '' }));

    const result = await withRunContext(worktreeContext(), () =>
      new DiagnosticsTool().call({
        command: 'add',
        path: 'paper.tex',
        line: 3,
        message: 'tighten this claim',
        severity: 4,
        confidence: 5,
      }),
    );

    expect(result.summary).toBe('Criticism not accepted');
  });

  it('resolves the path and summarizes an accepted criticism', async () => {
    const entries: unknown[] = [];
    setAddCriticismSink((entry) => {
      entries.push(entry);
      return { accepted: true, resolvedPath: entry.absolutePath };
    });

    const result = await withRunContext(worktreeContext(), () =>
      new DiagnosticsTool().call({
        command: 'add',
        path: 'paper.tex',
        line: 3,
        message: 'tighten this claim',
        severity: 4,
        confidence: 5,
      }),
    );

    expect(entries).toEqual([
      {
        absolutePath: '/worktree/paper.tex',
        line: 3,
        message: 'tighten this claim',
        severity: 4,
        confidence: 5,
      },
    ]);
    expect(result.summary).toBe(
      'Added criticism for /worktree/paper.tex:3 (S4/C5)',
    );
  });
});
