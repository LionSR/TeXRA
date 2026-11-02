// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { expect, vi } from 'vitest';

// Local imports
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { fakePath } from '@test/support/FakePlatform';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import {
  EditorHost,
  makeEditorHost,
  type EditorCapabilities,
} from '@texra/tools/editorHost';
import { OpenPdfTool } from '@texra/tools/OpenPdfTool';
import type { RunId } from '@texra-ai/harness/schemas';

/** The request shape the host's PDF opener receives, derived from the port. */
type OpenPdfRequest = Parameters<NonNullable<EditorCapabilities['openPdf']>>[0];

/** The registry the tool reads; each test attaches its viewer to it. */
const editors = makeEditorHost();

/** The process, over a fresh host per test and a session over its roots
 *  whose requests a person answers from the view. */
const perTest = Layer.provideMerge(
  TestSession.layer(undefined, { host: {} }),
  Layer.provideMerge(
    FakeHost.layer({
      workspacePath: fakePath('workspace'),
      // A real PDF outside the working directory, so only the path rule
      // refuses it.
      files: { '/run/paper.pdf': '%PDF-1.4\n' },
    }),
    SessionGraph.layer,
  ),
);

// Live clock: the session's publisher and readers run on real turns.
layer(perTest, { buildPerTest: true, excludeTestServices: true })(
  'OpenPdfTool',
  (it) => {
    /** Attach a PDF viewer the way a host does: to the editor registry, for
     *  the calling test's scope. */
    const installOpener = Effect.gen(function* () {
      const openPdf = vi.fn<(request: OpenPdfRequest) => Effect.Effect<void>>();
      openPdf.mockReturnValue(Effect.void);
      yield* editors.attach((yield* TestSession).roots.storage, { openPdf });
      return openPdf;
    });

    it.effect(
      'rejects arbitrary absolute paths outside the allowed roots',
      () =>
        Effect.gen(function* () {
          const openPdf = yield* installOpener;
          const session = yield* Effect.flatMap(TestSession, sessionHandleOf);

          const result = yield* OpenPdfTool.call({
            path: fakePath('run/paper.pdf'),
          }).pipe(
            Effect.provideService(EditorHost, editors),
            Effect.provide(
              nativeToolTestLayer({
                workingDirectory: fakePath('workspace'),
                run: { session, runId: 'tool-test' as RunId, toolPolicy: {} },
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
