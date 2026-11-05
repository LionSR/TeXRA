import { it } from '@effect/vitest';
import { Effect, FileSystem, Layer, Schema } from 'effect';
import { describe, expect } from 'vitest';

import { AppSignals } from '@texra-ai/harness/host';
import { RunIdSchema } from '@texra-ai/harness/schemas';
import { ProgressWorkflowFileActionsController } from '@texra/controllers/progressView/ProgressWorkflowFileActionsController';

const RUN = Schema.decodeUnknownSync(RunIdSchema)('ab12cd');

/** The controller's deps are file-local; derive them from its constructor. */
type ProgressWorkflowFileActionsControllerDeps = ConstructorParameters<
  typeof ProgressWorkflowFileActionsController
>[0];

const EDITED = '/workspace/edited.tex';

function createDeps(
  overrides: Partial<ProgressWorkflowFileActionsControllerDeps['host']>,
): ProgressWorkflowFileActionsControllerDeps {
  return {
    state: {
      getOutputFiles: () => ({
        0: [
          {
            source: 'edited.tex',
            location: {
              kind: 'workspace',
              absolutePath: EDITED,
              relativePath: 'edited.tex',
            },
            round: 0,
            lineage: null,
            diff: null,
          },
        ],
      }),
    },
    host: {
      compareFiles: () => Effect.void,
      acceptEditedFile: () => Effect.void,
      openDirectory: () => Effect.void,
      showInfo: () => Effect.void,
      ...overrides,
    },
    storageRoot: '/storage',
    runs: { merge: () => Effect.void, followUpLauncher: () => Effect.void },
  };
}

describe('ProgressWorkflowFileActionsController', () => {
  it.effect(
    'sends no accept follow-up when the host cancels acceptance, and one when it accepts',
    () =>
      Effect.gen(function* () {
        const followUps: string[] = [];
        const acceptResults = [false, true];
        const deps = createDeps({
          acceptEditedFile: () => Effect.sync(() => acceptResults.shift()),
        });
        deps.runs.followUpLauncher = (_run, text) =>
          Effect.sync(() => {
            followUps.push(text);
          });
        const controller = new ProgressWorkflowFileActionsController(deps);

        yield* controller.acceptFile(EDITED, '/workspace/base.tex', RUN);

        expect(followUps).toEqual([]);

        yield* controller.acceptFile(EDITED, '/workspace/base.tex', RUN);

        expect(followUps).toHaveLength(1);
        expect(followUps[0]).toMatch(/edited\.tex/);
        expect(followUps[0]).toMatch(/\+user edited output/);
      }).pipe(
        Effect.provide(
          Layer.merge(
            FileSystem.layerNoop({
              // The model's copy the revision kept, and the file the user
              // changed before accepting.
              readFileString: (path) =>
                Effect.succeed(
                  path.includes('/model/r0/')
                    ? 'original model output\n'
                    : 'user edited output\n',
                ),
            }),
            AppSignals.layer,
          ),
        ),
      ),
  );
});
