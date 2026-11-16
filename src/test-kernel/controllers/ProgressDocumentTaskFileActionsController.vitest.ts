import { layer } from '@effect/vitest';
import { Effect, FileSystem, Layer, Schema } from 'effect';
import { expect } from 'vitest';

import { sessionFsLayer } from '@texra-ai/harness/host';
import { AppSignals } from '@texra-ai/harness/plugins';
import { RunIdSchema } from '@texra-ai/harness/schemas';
import { ProgressDocumentTaskFileActionsController } from '@texra/controllers/progressView/ProgressDocumentTaskFileActionsController';
import { SessionGraph } from '@test/support/testKernel';

const RUN = Schema.decodeUnknownSync(RunIdSchema)('ab12cd');

/** The controller's deps are file-local; derive them from its constructor. */
type ProgressDocumentTaskFileActionsControllerDeps = ConstructorParameters<
  typeof ProgressDocumentTaskFileActionsController
>[0];

const EDITED = '/workspace/edited.tex';

function createDeps(
  overrides: Partial<ProgressDocumentTaskFileActionsControllerDeps['host']>,
): ProgressDocumentTaskFileActionsControllerDeps {
  return {
    rounds: () => [
      {
        round: 0,
        outputs: [
          {
            source: 'edited.tex',
            location: {
              kind: 'workspace',
              absolutePath: EDITED,
              relativePath: 'edited.tex',
            },
            round: 0,
            lineage: {
              base: {
                kind: 'runStorage',
                absolutePath: '/storage/base.tex',
                relativePath: 'base.tex',
                runId: RUN,
              },
              document: {
                kind: 'workspace',
                absolutePath: '/workspace/base.tex',
                relativePath: 'base.tex',
              },
            },
            diff: null,
          },
        ],
        compile: null,
        missingOutputs: [],
        latexdiffs: [],
        reply: null,
      },
    ],
    host: {
      openDiff: () => Effect.void,
      confirm: () => Effect.succeed(true),
      openDirectory: () => Effect.void,
      showInfo: () => Effect.void,
      ...overrides,
    },
    storageRoot: '/storage',
    workspace: '/workspace',
    runs: { merge: () => Effect.void, followUpLauncher: () => Effect.void },
    latexdiff: () => Effect.void,
  };
}

layer(SessionGraph.hosted)(
  'ProgressDocumentTaskFileActionsController',
  (it) => {
    it.effect(
      'sends no accept follow-up when the host cancels acceptance, and one when it accepts',
      () =>
        Effect.gen(function* () {
          const followUps: string[] = [];
          const confirmations = [false, true];
          const deps = createDeps({
            confirm: () => Effect.sync(() => confirmations.shift() ?? false),
          });
          deps.runs.followUpLauncher = (_run, text) =>
            Effect.sync(() => {
              followUps.push(text);
            });
          const controller = new ProgressDocumentTaskFileActionsController(
            deps,
          );

          const accept = controller.handle({
            kind: 'fileAction',
            action: 'accept',
            file: EDITED,
            base: { kind: 'runOutput', runId: RUN },
          });
          yield* accept;

          expect(followUps).toEqual([]);

          yield* accept;

          expect(followUps).toHaveLength(1);
          expect(followUps[0]).toMatch(/edited\.tex/);
          expect(followUps[0]).toMatch(/\+user edited output/);
        }).pipe(
          Effect.provide(
            Layer.merge(
              FileSystem.layerNoop({
                exists: () => Effect.succeed(true),
                realPath: (absolutePath) => Effect.succeed(absolutePath),
                // cast: the accept reads only the target's mode.
                stat: () =>
                  Effect.succeed({ mode: 0o644 } as FileSystem.File.Info),
                chmod: () => Effect.void,
                writeFileString: () => Effect.void,
                rename: () => Effect.void,
                remove: () => Effect.void,
                // The model's copy the revision kept, and the file the user
                // changed before accepting.
                readFile: () =>
                  Effect.succeed(
                    new TextEncoder().encode('original model output\n'),
                  ),
                readFileString: () => Effect.succeed('user edited output\n'),
              }),
              AppSignals.layer,
            ),
          ),
          Effect.provide(
            sessionFsLayer({ workspace: '/workspace', storage: '/storage' }),
          ),
        ),
    );
  },
);
