import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect, type FileSystem, Layer } from 'effect';
import { describe, expect, it } from 'vitest';

import { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import { AgentResume } from '@platform/interfaces';
import type { RunId } from '@shared/schemas';

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

/**
 * What both hosts' request dispatchers carry when they yield a file action.
 * No action in this suite reaches either service; they satisfy the action's
 * requirements so it runs here as it runs there.
 */
const dispatcherServices = Layer.mergeAll(
  NodeFileSystem.layer,
  AgentResume.layer({ tryResumeRun: () => Effect.succeed(false) }),
);

const runAction = <A, E>(
  action: Effect.Effect<A, E, FileSystem.FileSystem | AgentResume>,
): Promise<A> =>
  Effect.runPromise(action.pipe(Effect.provide(dispatcherServices)));

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
    mergeFile: () => Effect.void,
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
    sendFollowUp: () => Effect.void,
  };
}

describe('ProgressWorkflowFileActionsController', () => {
  it('keeps the accept follow-up backup when the host cancels acceptance', async () => {
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
    deps.sendFollowUp = (_stream, text) =>
      Effect.sync(() => {
        followUps.push(text);
      });
    const controller = new ProgressWorkflowFileActionsController(deps);

    await runAction(
      controller.compareOriginal(
        '/workspace/edited.tex',
        '/workspace/base.tex',
        RUN,
      ),
    );
    await runAction(
      controller.acceptFile(
        '/workspace/edited.tex',
        '/workspace/base.tex',
        RUN,
      ),
    );

    expect(followUps).toEqual([]);

    await runAction(
      controller.acceptFile(
        '/workspace/edited.tex',
        '/workspace/base.tex',
        RUN,
      ),
    );

    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatch(/edited\.tex/);
  });
});
