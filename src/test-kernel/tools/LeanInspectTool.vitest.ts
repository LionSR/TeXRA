import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect, vi } from 'vitest';

import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  LeanLanguageServices,
  type LeanLanguageServicesShape,
} from '@tools/lean/leanLanguageServices';
import { LeanInspectTool } from '@tools/lean/LspTools';

const GOAL_INSPECT_INPUT = {
  type: 'goal',
  file: 'Proof.lean',
  line: 12,
  column: 3,
} as const;

function fakeServices(
  overrides: Partial<LeanLanguageServicesShape>,
): LeanLanguageServicesShape {
  return {
    executeFileCommand: vi.fn(),
    getGoalState: vi.fn(),
    getTermGoal: vi.fn(),
    getHoverInfo: vi.fn(),
    fetchDiagnosticsForFile: vi.fn(),
    navigateToFirstError: vi.fn(),
    executeProjectCommand: vi.fn(),
    ...overrides,
  } as LeanLanguageServicesShape;
}

/** The fake port is provided innermost, ahead of the test host's real one. */
function callTool(
  input: typeof GOAL_INSPECT_INPUT,
  services: Partial<LeanLanguageServicesShape>,
) {
  return new LeanInspectTool()
    .call(input)
    .pipe(
      Effect.provideService(LeanLanguageServices, fakeServices(services)),
      Effect.provide(nativeToolTestLayer()),
    );
}

describe('LeanInspectTool', () => {
  it.effect(
    'reports a failing language-server request with a per-type summary',
    () =>
      Effect.gen(function* () {
        // A port failure settles the program's run as a failed Exit, which the
        // execute() boundary folds into a ToolError carrying the summary that
        // names which inspection failed.
        const result = yield* callTool(GOAL_INSPECT_INPUT, {
          getGoalState: vi.fn(() =>
            Effect.die(new Error('Lean server not running')),
          ),
        });

        expect(result).toMatchObject({
          status: 'error',
          summary: 'Failed to get goal',
          diagnostics: { name: 'ToolError' },
        });
        expect(result.error).toContain('Lean server not running');
      }),
  );

  it.effect(
    'passes a missing-goal response through as its own error result',
    () =>
      Effect.gen(function* () {
        // A resolved "no data" answer is a normal outcome, not a thrown failure:
        // it must keep its own message instead of being wrapped as a ToolError.
        const result = yield* callTool(GOAL_INSPECT_INPUT, {
          getGoalState: vi.fn(() =>
            Effect.succeed({ data: null, error: 'no goal here' }),
          ),
        });

        expect(result).toMatchObject({
          status: 'error',
          summary: 'No goal state',
        });
        expect(result.error).toContain(
          'Could not get goal state at Proof.lean:12:3',
        );
      }),
  );
});
