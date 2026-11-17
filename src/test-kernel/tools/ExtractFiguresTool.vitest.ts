// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { expect } from 'vitest';

// Local imports
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import { ExtractLatexFiguresTool } from '@texra/tools/latex/ExtractFiguresTool';
import { generateRunId } from '@texra-ai/harness/schemas';

/** A paper in a subdirectory of the workspace, its figure beside it. */
const perTest = Layer.provideMerge(
  TestSession.layer(),
  Layer.provideMerge(
    SessionGraph.layer,
    FakeHost.layer({
      files: {
        '/workspace/paper/main.tex': '\\includegraphics{plot.png}\n',
        '/workspace/paper/plot.png': 'fake-png-bytes',
      },
    }),
  ),
);

// Failure mode: a figure path relative to the `.tex` file's directory is
// read against the workspace root, so a paper outside the root attaches a
// file that is not there.
layer(perTest, { buildPerTest: true, excludeTestServices: true })(
  'ExtractLatexFiguresTool',
  (it) => {
    it.effect('attaches a figure beside a .tex file in a subdirectory', () =>
      Effect.gen(function* () {
        const host = yield* FakeHost;
        const session = yield* Effect.flatMap(TestSession, sessionHandleOf);

        const result = yield* ExtractLatexFiguresTool.call({
          texPath: 'paper/main.tex',
        }).pipe(
          Effect.provide(
            nativeToolTestLayer({
              workingDirectory: host.path('workspace'),
              run: { session, runId: generateRunId(), toolPolicy: {} },
            }),
          ),
        );

        expect(result).toMatchObject({
          status: 'executed',
          files: [{ path: 'paper/plot.png' }],
        });
      }),
    );
  },
);
