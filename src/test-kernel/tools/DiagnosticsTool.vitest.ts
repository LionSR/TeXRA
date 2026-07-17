import { describe, expect, it, vi } from 'vitest';

import { createTestSession } from '@test/support/sessionTestUtils';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { DiagnosticsTool, type DiagnosticsInput } from '@tools/DiagnosticsTool';
import type { GenericDiagnostic } from '@utils/diagnostics/diagnosticFormatting';

function worktreeContext(session: SessionHandle) {
  return createRunContext({
    runtimeHost: { emit: vi.fn() },
    workingDirectory: '/worktree',
    session,
  });
}

/** Runs `run` against a fresh test session, always disposing it afterward. */
async function withSession(
  run: (session: SessionHandle) => Promise<void>,
): Promise<void> {
  const session = createTestSession();
  try {
    await run(session);
  } finally {
    session.dispose();
  }
}

function addCriticismCall(): Extract<DiagnosticsInput, { command: 'add' }> {
  return {
    command: 'add',
    path: 'paper.tex',
    line: 3,
    message: 'tighten this claim',
    severity: 4,
    confidence: 5,
  };
}

describe('DiagnosticsTool', () => {
  it('reports a capability error when the session has no diagnostics reader', async () => {
    await withSession(async (session) => {
      const result = await withRunContext(worktreeContext(session), () =>
        new DiagnosticsTool().call({ command: 'list', path: 'paper.tex' }),
      );

      expect(result).toMatchObject({
        status: 'error',
        diagnostics: { name: 'ToolError' },
      });
      expect(result.error).toContain('Diagnostics capability unavailable');
    });
  });

  it('reads diagnostics through the run context session', async () => {
    await withSession(async (session) => {
      const readDiagnostics = vi.fn(async (_path: string) => {
        return [] as GenericDiagnostic[];
      });
      session.useHostInteractions({ readDiagnostics, cancel: vi.fn() });

      const result = await withRunContext(worktreeContext(session), () =>
        new DiagnosticsTool().call({ command: 'list', path: 'paper.tex' }),
      );

      expect(readDiagnostics).toHaveBeenCalledWith('/worktree/paper.tex');
      expect(result.diagnostics).toMatchObject({
        path: '/worktree/paper.tex',
        command: 'list',
      });
    });
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
    await withSession(async (session) => {
      const result = await withRunContext(worktreeContext(session), () =>
        new DiagnosticsTool().call(addCriticismCall()),
      );

      expect(result).toMatchObject({
        status: 'error',
        diagnostics: { name: 'ToolError' },
      });
      expect(result.error).toContain('Diagnostics add capability unavailable');
    });
  });

  it('reports when the criticism sink does not accept (feature disabled)', async () => {
    await withSession(async (session) => {
      session.useHostInteractions({
        addCriticism: () => ({ accepted: false, resolvedPath: '' }),
        cancel: vi.fn(),
      });

      const result = await withRunContext(worktreeContext(session), () =>
        new DiagnosticsTool().call(addCriticismCall()),
      );

      expect(result.summary).toBe('Criticism not accepted');
    });
  });

  it('resolves the path and summarizes an accepted criticism', async () => {
    await withSession(async (session) => {
      const entries: unknown[] = [];
      session.useHostInteractions({
        addCriticism: (entry) => {
          entries.push(entry);
          return { accepted: true, resolvedPath: entry.absolutePath };
        },
        cancel: vi.fn(),
      });

      const result = await withRunContext(worktreeContext(session), () =>
        new DiagnosticsTool().call(addCriticismCall()),
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
});
