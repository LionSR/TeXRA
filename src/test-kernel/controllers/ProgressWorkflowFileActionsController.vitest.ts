import { it } from '@effect/vitest';
import { Effect, FileSystem, Layer } from 'effect';
import { describe, expect } from 'vitest';

import { AppSignals } from '@texra-ai/harness/host';
import type { RunId } from '@shared/schemas';
import { ProgressWorkflowFileActionsController } from '@texra/controllers/progressView/ProgressWorkflowFileActionsController';

const RUN = 'ab12cd' as RunId;

/** The controller's deps are file-local; derive them from its constructor. */
type ProgressWorkflowFileActionsControllerDeps = ConstructorParameters<
  typeof ProgressWorkflowFileActionsController
>[0];

function createDeps(
  overrides: Partial<ProgressWorkflowFileActionsControllerDeps['host']>,
): ProgressWorkflowFileActionsControllerDeps {
  return {
    state: { getOutputFiles: () => ({}) },
    host: {
      compareFiles: () => Effect.void,
      acceptEditedFile: () => Effect.void,
      latexdiffFile: () => Effect.void,
      openDirectory: () => Effect.void,
      showInfo: () => Effect.void,
      showError: () => Effect.void,
      ...overrides,
    },
    storageRoot: '/storage',
    runs: { merge: () => Effect.void, sendFollowUp: () => Effect.void },
  };
}

describe('ProgressWorkflowFileActionsController', () => {
  it.effect(
    'keeps the accept follow-up backup when the host cancels acceptance',
    () => {
      const readResults = [
        'original model output',
        'user edited output',
        'user edited output',
      ];
      return Effect.gen(function* () {
        const followUps: string[] = [];
        const acceptResults = [false, true];
        const deps = createDeps({
          acceptEditedFile: () => Effect.sync(() => acceptResults.shift()),
        });
        deps.runs.sendFollowUp = (_stream, text) =>
          Effect.sync(() => {
            followUps.push(text);
          });
        const controller = new ProgressWorkflowFileActionsController(deps);

        yield* controller.compareOriginal(
          '/workspace/edited.tex',
          '/workspace/base.tex',
          RUN,
        );
        yield* controller.acceptFile(
          '/workspace/edited.tex',
          '/workspace/base.tex',
          RUN,
        );

        expect(followUps).toEqual([]);

        yield* controller.acceptFile(
          '/workspace/edited.tex',
          '/workspace/base.tex',
          RUN,
        );

        expect(followUps).toHaveLength(1);
        expect(followUps[0]).toMatch(/edited\.tex/);
      }).pipe(
        Effect.provide(
          Layer.merge(
            FileSystem.layerNoop({
              readFileString: () =>
                Effect.sync(() => readResults.shift() ?? ''),
            }),
            AppSignals.layer,
          ),
        ),
      );
    },
  );
});
