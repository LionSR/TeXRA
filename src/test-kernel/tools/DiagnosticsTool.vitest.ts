import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { DiagnosticsTool } from '@tools/DiagnosticsTool';
import type { GenericDiagnostic } from '@utils/diagnostics/diagnosticFormatting';
import { installPlatform } from '../support/setupPlatform';
import type { AddCriticismSink } from '@platform/interfaces';

afterEach(async () => {
  await installPlatform();
});

function installLinter(
  linter: (path: string) => Promise<GenericDiagnostic[]>,
): Promise<void> {
  return installPlatform({}, { linter });
}

function installAddCriticismSink(
  addCriticismSink: AddCriticismSink,
): Promise<void> {
  return installPlatform({}, { addCriticismSink });
}

function worktreeContext() {
  return createRunContext({
    runtimeHost: { emit: vi.fn() },
    workingDirectory: '/worktree',
  });
}

describe('DiagnosticsTool', () => {
  it('reports a capability error when the host has no linter', async () => {
    await installPlatform({}, { linter: undefined });

    const result = await withRunContext(worktreeContext(), () =>
      new DiagnosticsTool().call({ command: 'list', path: 'paper.tex' }),
    );

    expect(result).toMatchObject({
      status: 'error',
      error:
        'Diagnostics capability unavailable: this host did not configure Platform.linter.',
      diagnostics: { name: 'ToolError' },
    });
  });

  it('reads diagnostics from the active working directory root', async () => {
    const paths: string[] = [];
    await installLinter(async (path) => {
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

    expect(result.status).toBe('error');
    // Now caught by DiagnosticsInputSchema's discriminated union (the `add`
    // variant requires these fields) rather than a hand-rolled message, so
    // the structured Zod diagnostics list each missing field individually.
    expect(result.error).toContain('at line');
    expect(result.error).toContain('at message');
    expect(result.error).toContain('at severity');
    expect(result.error).toContain('at confidence');
  });

  it('reports a capability error when the host has no criticism sink', async () => {
    await installPlatform({}, { addCriticismSink: undefined });

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

    expect(result).toMatchObject({
      status: 'error',
      error:
        'Diagnostics add capability unavailable: this host did not configure Platform.addCriticismSink.',
      diagnostics: { name: 'ToolError' },
    });
  });

  it('reports when the criticism sink does not accept (feature disabled)', async () => {
    await installAddCriticismSink(() => ({
      accepted: false,
      resolvedPath: '',
    }));

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
    await installAddCriticismSink((entry) => {
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
