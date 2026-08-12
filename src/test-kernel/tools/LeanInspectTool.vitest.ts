import { describe, expect, it, vi } from 'vitest';

import {
  setLeanLanguageServices,
  type LeanLanguageServices,
} from '@tools/lean/leanLanguageServices';
import { LeanInspectTool } from '@tools/lean/LspTools';

const GOAL_INSPECT_INPUT = {
  type: 'goal',
  file: 'Proof.lean',
  line: 12,
  column: 3,
} as const;

function installServices(overrides: Partial<LeanLanguageServices>): void {
  setLeanLanguageServices({
    executeFileCommand: vi.fn(),
    getGoalState: vi.fn(),
    getTermGoal: vi.fn(),
    getHoverInfo: vi.fn(),
    fetchDiagnosticsForFile: vi.fn(),
    navigateToFirstError: vi.fn(),
    executeProjectCommand: vi.fn(),
    ...overrides,
  } as LeanLanguageServices);
}

describe('LeanInspectTool', () => {
  it('reports a failing language-server request with a per-type summary', async () => {
    // The dispatch must be awaited inside execute()'s try block; a bare
    // `return this.executeGoal(...)` settles the promise after the try has
    // exited, so the rejection reaches the caller unwrapped and loses the
    // summary that names which inspection failed.
    installServices({
      getGoalState: vi.fn(async () => {
        throw new Error('Lean server not running');
      }),
    });

    const result = await new LeanInspectTool().call(GOAL_INSPECT_INPUT);

    expect(result).toMatchObject({
      status: 'error',
      summary: 'Failed to get goal',
      diagnostics: { name: 'ToolError' },
    });
    expect(result.error).toContain('Lean server not running');
  });

  it('passes a missing-goal response through as its own error result', async () => {
    // A resolved "no data" answer is a normal outcome, not a thrown failure:
    // it must keep its own message instead of being wrapped as a ToolError.
    installServices({
      getGoalState: vi.fn(async () => ({ data: null, error: 'no goal here' })),
    });

    const result = await new LeanInspectTool().call(GOAL_INSPECT_INPUT);

    expect(result).toMatchObject({ status: 'error', summary: 'No goal state' });
    expect(result.error).toContain(
      'Could not get goal state at Proof.lean:12:3',
    );
  });
});
