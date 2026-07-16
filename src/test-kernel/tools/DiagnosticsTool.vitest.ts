import { describe, expect, it, vi } from 'vitest';

import { createTestSession } from '@test/support/sessionTestUtils';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { DiagnosticsTool } from '@tools/DiagnosticsTool';
import type { GenericDiagnostic } from '@utils/diagnostics/diagnosticFormatting';

function worktreeContext(session: SessionHandle) {
  return createRunContext({
    runtimeHost: { emit: vi.fn() },
    workingDirectory: '/worktree',
    session,
  });
}

describe('DiagnosticsTool', () => {
  it('reports a capability error when the session has no diagnostics reader', async () => {
    const session = createTestSession();

    try {
      const result = await withRunContext(worktreeContext(session), () =>
        new DiagnosticsTool().call({ command: 'list', path: 'paper.tex' }),
      );

      expect(result).toMatchObject({
        status: 'error',
        diagnostics: { name: 'ToolError' },
      });
      expect(result.error).toContain('Diagnostics capability unavailable');
    } finally {
      session.dispose();
    }
  });

  it('reads diagnostics through the run context session', async () => {
    const session = createTestSession();
    const readDiagnostics = vi.fn(async (_path: string) => {
      return [] as GenericDiagnostic[];
    });
    session.useHostInteractions({ readDiagnostics, cancel: vi.fn() });

    try {
      const result = await withRunContext(worktreeContext(session), () =>
        new DiagnosticsTool().call({ command: 'list', path: 'paper.tex' }),
      );

      expect(readDiagnostics).toHaveBeenCalledWith('/worktree/paper.tex');
      expect(result.diagnostics).toMatchObject({
        path: '/worktree/paper.tex',
        command: 'list',
      });
    } finally {
      session.dispose();
    }
  });

  it('rejects an add command missing required fields', async () => {
    const result = await new DiagnosticsTool().call({
      command: 'add',
      path: 'paper.tex',
    });

    expect(result.status).toBe('error');
    // Now caught by DiagnosticsInputSchema's discriminated union (the `add`
    // variant requires these fields) rather than a hand-rolled message, so
    // the structured Zod diagnostics list each missing field individually.
    expect(result.error).toContain('at line');
    expect(result.error).toContain('at message');
    expect(result.error).toContain('at severity');
    expect(result.error).toContain('at confidence');
  });

  it('reports a capability error when the session has no criticism sink', async () => {
    const session = createTestSession();

    try {
      const result = await withRunContext(worktreeContext(session), () =>
        new DiagnosticsTool().call({
          command: 'add',
          path: 'paper.tex',
          line: 3,
          message: 'tighten this claim',
          severity: 4,
          confidence: 5,
        }),
      );

      expect(result).toMatchObject({
        status: 'error',
        diagnostics: { name: 'ToolError' },
      });
      expect(result.error).toContain('Diagnostics add capability unavailable');
    } finally {
      session.dispose();
    }
  });

  it('reports when the criticism sink does not accept (feature disabled)', async () => {
    const session = createTestSession();
    session.useHostInteractions({
      addCriticism: () => ({ accepted: false, resolvedPath: '' }),
      cancel: vi.fn(),
    });

    try {
      const result = await withRunContext(worktreeContext(session), () =>
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
    } finally {
      session.dispose();
    }
  });

  it('resolves the path and summarizes an accepted criticism', async () => {
    const session = createTestSession();
    const entries: unknown[] = [];
    session.useHostInteractions({
      addCriticism: (entry) => {
        entries.push(entry);
        return { accepted: true, resolvedPath: entry.absolutePath };
      },
      cancel: vi.fn(),
    });

    try {
      const result = await withRunContext(worktreeContext(session), () =>
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
    } finally {
      session.dispose();
    }
  });
});
