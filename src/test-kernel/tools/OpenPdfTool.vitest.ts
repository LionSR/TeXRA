import '@test/support/sessionGraphTestSetup';

import { it } from '@effect/vitest';
import { Effect } from 'effect';

// Test composition imports

// Third-party imports
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import type { RunId } from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { setupPlatform } from '@test/support/setupPlatform';
import { fakePath } from '@test/support/FakePlatform';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import {
  closeTestSession,
  openTestDefaultSession,
} from '@test/support/sessionEnd';
import {
  EditorHost,
  makeEditorHost,
  type EditorCapabilities,
} from '@texra/tools/editorHost';
import { OpenPdfTool } from '@texra/tools/OpenPdfTool';

/** The request shape the host's PDF opener receives, derived from the port. */
type OpenPdfRequest = Parameters<NonNullable<EditorCapabilities['openPdf']>>[0];

/** The registry the tool reads; each test attaches its viewer to it. */
const editors = makeEditorHost();

describe('OpenPdfTool', () => {
  setupPlatform({
    workspacePath: fakePath('workspace'),
    storagePath: fakePath('storage'),
    files: {
      '/workspace/paper.pdf': '%PDF-1.4\n',
      '/workspace/figures/result.pdf': '%PDF-1.4\n',
      '/run/paper.pdf': '%PDF-1.4\n',
      '/storage/executions/run-1/output.pdf': '%PDF-1.4\n',
      '/workspace/paper.tex': '\\documentclass{article}',
    },
  });

  let sessionRoot: string | undefined;

  beforeEach(async () => {
    const session = await Effect.runPromise(
      openTestDefaultSession({
        roots: testWorkspaceRoots(),
        transcriptMode: { kind: 'ephemeral' },
      }),
    );
    sessionRoot = session.roots.storage;
  });

  afterEach(async () => {
    const root = sessionRoot;
    sessionRoot = undefined;
    if (root === undefined) return;
    const report = await Effect.runPromise(closeTestSession(root));
    if (!report.settled || report.abandoned.length > 0) {
      throw new Error(
        `OpenPdfTool test session did not close: ${report.abandoned.join(', ')}`,
      );
    }
  });

  /** Attach a PDF viewer the way a host does: to the editor registry, for
   *  the calling test's scope. */
  const installOpener = Effect.gen(function* () {
    const openPdf = vi.fn<(request: OpenPdfRequest) => Effect.Effect<void>>();
    openPdf.mockReturnValue(Effect.void);
    yield* editors.attach(testDefaultSession().roots.storage, { openPdf });
    return openPdf;
  });

  function expectOpenError(result: unknown, fragment: string): void {
    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining(fragment),
    });
  }

  it.effect('rejects arbitrary absolute paths outside the allowed roots', () =>
    Effect.gen(function* () {
      const openPdf = yield* installOpener;
      const tool = OpenPdfTool;

      const result = yield* tool.call({ path: fakePath('run/paper.pdf') }).pipe(
        Effect.provideService(EditorHost, editors),
        Effect.provide(
          nativeToolTestLayer({
            workingDirectory: fakePath('workspace'),
            run: {
              session: testDefaultSession(),
              runId: 'tool-test' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      );

      expectOpenError(result, 'Path must stay within the working directory');
      expect(openPdf).not.toHaveBeenCalled();
    }).pipe(
      Effect.provideService(EditorHost, editors),
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: testDefaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );
});
