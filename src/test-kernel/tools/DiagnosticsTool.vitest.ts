import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { DiagnosticsTool, setLinterProvider } from '@tools/DiagnosticsTool';

afterEach(() => {
  setLinterProvider(async () => []);
});

describe('DiagnosticsTool', () => {
  it('reads diagnostics from the active working directory root', async () => {
    const paths: string[] = [];
    setLinterProvider(async (path) => {
      paths.push(path);
      return [];
    });
    const context = createRunContext({
      runtimeHost: { emit: vi.fn() },
      workingDirectory: '/worktree',
    });

    const result = await withRunContext(context, () =>
      new DiagnosticsTool().call({ command: 'list', path: 'paper.tex' }),
    );

    expect(paths).toEqual(['/worktree/paper.tex']);
    expect(result.diagnostics).toMatchObject({
      path: '/worktree/paper.tex',
      command: 'list',
    });
  });
});
