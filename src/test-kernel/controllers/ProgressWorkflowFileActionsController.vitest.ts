import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import type { RunId } from '@shared/schemas';
import { ProgressWorkflowFileActionsController } from '@texra/controllers/progressView/ProgressWorkflowFileActionsController';

const RUN = 'ab12cd' as RunId;

/** The controller's deps are file-local; derive them from its constructor. */
type ProgressWorkflowFileActionsControllerDeps = ConstructorParameters<
  typeof ProgressWorkflowFileActionsController
>[0];

type RecordingHost = ProgressWorkflowFileActionsControllerDeps['host'] & {
  infos: string[];
  errors: string[];
};

type RecordingDeps = ProgressWorkflowFileActionsControllerDeps & {
  host: RecordingHost;
};

function createDeps(
  overrides: Partial<ProgressWorkflowFileActionsControllerDeps['host']>,
): RecordingDeps {
  const infos: string[] = [];
  const errors: string[] = [];
  const host: RecordingHost = {
    infos,
    errors,
    compareFiles: () => Effect.void,
    acceptEditedFile: () => Effect.void,
    latexdiffFile: () => Effect.void,
    openDirectory: () => Effect.void,
    readFile: () => Effect.succeed(''),
    showInfo: (message) =>
      Effect.sync(() => {
        infos.push(message);
      }),
    showError: (message) =>
      Effect.sync(() => {
        errors.push(message);
      }),
    ...overrides,
  };

  return {
    state: {
      getOutputFiles: () => ({}),
    },
    host,
    storageRoot: '/storage',
    runs: { merge: () => Effect.void, sendFollowUp: () => Effect.void },
  };
}

describe('ProgressWorkflowFileActionsController', () => {
  it.effect(
    'keeps the accept follow-up backup when the host cancels acceptance',
    () =>
      Effect.gen(function* () {
        const followUps: string[] = [];
        const acceptResults = [false, true];
        const readResults = [
          'original model output',
          'user edited output',
          'user edited output',
        ];
        const deps = createDeps({
          acceptEditedFile: () => Effect.sync(() => acceptResults.shift()),
          readFile: () => Effect.sync(() => readResults.shift() ?? ''),
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
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});
