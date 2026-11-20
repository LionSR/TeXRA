// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { expect, vi } from 'vitest';

// Local imports
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import { EditorHost, type EditorCapabilities } from '@texra/tools/editorHost';
import { OpenPdfTool } from '@texra/tools/OpenPdfTool';
import { generateRunId } from '@texra-ai/harness/schemas';

/** The request shape the host's PDF opener receives, derived from the port. */
type OpenPdfRequest = Parameters<NonNullable<EditorCapabilities['openPdf']>>[0];

/** The process, over a fresh host per test and a session over its roots
 *  whose requests a person answers from the view. */
const perTest = Layer.provideMerge(
  TestSession.layer(undefined, { answeredFromView: true }),
  Layer.provideMerge(
    SessionGraph.layer,
    FakeHost.layer({
      // A real PDF outside the working directory, so only the path rule
      // refuses it.
      files: { '/run/paper.pdf': '%PDF-1.4\n' },
    }),
  ),
);

// Live clock: the session's publisher and readers run on real turns.
layer(perTest, { buildPerTest: true, excludeTestServices: true })(
  'OpenPdfTool',
  (it) => {
    /** A PDF viewer, offered for every storage root. */
    const installOpener = Effect.sync(() => {
      const openPdf = vi.fn<(request: OpenPdfRequest) => Effect.Effect<void>>();
      openPdf.mockReturnValue(Effect.void);
      return openPdf;
    });

    it.effect(
      'rejects arbitrary absolute paths outside the allowed roots',
      () =>
        Effect.gen(function* () {
          const host = yield* FakeHost;
          const openPdf = yield* installOpener;
          const session = yield* Effect.flatMap(TestSession, sessionHandleOf);

          const result = yield* OpenPdfTool.call({
            path: host.path('run/paper.pdf'),
          }).pipe(
            Effect.provideService(EditorHost, { at: () => ({ openPdf }) }),
            Effect.provide(
              nativeToolTestLayer({
                workingDirectory: host.path('workspace'),
                // cast: a fixture run id; no stored run is read under it.
                run: { session, runId: generateRunId(), toolPolicy: {} },
              }),
            ),
          );

          expect(result).toMatchObject({
            status: 'error',
            error: expect.stringContaining(
              'Path must stay within the working directory',
            ),
          });
          expect(openPdf).not.toHaveBeenCalled();
        }),
    );
  },
);
