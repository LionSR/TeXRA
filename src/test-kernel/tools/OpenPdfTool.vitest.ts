import '@test/support/defaultSessionTestSetup';

// Node imports
import * as path from 'node:path';
import { it } from '@effect/vitest';
import { Effect } from 'effect';

// Test composition imports

// Third-party imports
import { afterEach, describe, expect, vi, type Mock } from 'vitest';

// Local imports
import type { HostInteractions } from '@agent/runtime/HostInteractions';
import { defaultSession } from '@agent/runtime/SessionHandle';
import type { RunId } from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { setupPlatform } from '@test/support/setupPlatform';
import { fakePath } from '@test/support/FakePlatform';
import { OpenPdfTool } from '@tools/OpenPdfTool';

/** The request shape the host's PDF opener receives, derived from the port. */
type OpenPdfRequest = Parameters<NonNullable<HostInteractions['openPdf']>>[0];

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

  let detachHostInteractions = (): void => {};

  afterEach(() => {
    detachHostInteractions();
    detachHostInteractions = () => undefined;
  });

  /** Attach a PDF viewer the way a host does: as a session capability. */
  function installOpener(): Mock<(request: OpenPdfRequest) => Promise<void>> {
    const openPdf = vi.fn<(request: OpenPdfRequest) => Promise<void>>();
    openPdf.mockResolvedValue(undefined);
    detachHostInteractions();
    detachHostInteractions = defaultSession().interactions.use({
      openPdf,
    });
    return openPdf;
  }

  function expectOpenError(result: unknown, fragment: string): void {
    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining(fragment),
    });
  }

  function expectOpened(result: unknown, label: string): void {
    expect(result).toMatchObject({
      summary: `Opened PDF: ${label}`,
      output: `Opened PDF: ${label}`,
    });
  }

  it.effect(
    'reports that PDF opening is unavailable when no host serves it',
    () =>
      Effect.gen(function* () {
        const tool = new OpenPdfTool();

        const result = yield* tool.call({ path: 'paper.tex' });

        expectOpenError(result, 'open_pdf is not available');
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'tool-test' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.effect('opens an existing PDF through the registered host callback', () =>
    Effect.gen(function* () {
      const openPdf = installOpener();
      const tool = new OpenPdfTool();

      const result = yield* tool.call({
        path: 'figures/result.pdf',
        preserve_focus: true,
      });

      expectOpened(result, 'figures/result.pdf');
      expect(openPdf).toHaveBeenCalledWith({
        location: {
          kind: 'workspace',
          absolutePath: fakePath('workspace', 'figures', 'result.pdf'),
          relativePath: 'figures/result.pdf',
        },
        preserveFocus: true,
      });
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.effect('allows absolute paths inside active run storage', () =>
    Effect.gen(function* () {
      const openPdf = installOpener();
      const tool = new OpenPdfTool();

      const result = yield* tool
        .call({
          path: fakePath('storage/executions/run-1/output.pdf'),
          preserve_focus: true,
        })
        .pipe(
          Effect.provide(
            nativeToolTestLayer({
              run: {
                session: defaultSession(),
                runId: 'run-1' as RunId,
                toolPolicy: {},
              },
            }),
          ),
        );

      expectOpened(result, 'output.pdf');
      expect(openPdf).toHaveBeenCalledWith({
        location: {
          kind: 'runStorage',
          absolutePath: fakePath('storage/executions/run-1/output.pdf'),
          relativePath: 'output.pdf',
          runId: 'run-1',
        },
        preserveFocus: true,
      });
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.effect(
    'does not parse working_directory before checking absolute run-storage paths',
    () =>
      Effect.gen(function* () {
        const openPdf = installOpener();
        const tool = new OpenPdfTool();

        const result = yield* tool
          .call({ path: fakePath('storage/executions/run-1/output.pdf') })
          .pipe(
            Effect.provide(
              nativeToolTestLayer({
                workingDirectory: 'relative-path',
                run: {
                  session: defaultSession(),
                  runId: 'run-1' as RunId,
                  toolPolicy: {},
                },
              }),
            ),
          );

        expectOpened(result, 'output.pdf');
        expect(openPdf).toHaveBeenCalledOnce();
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'tool-test' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.effect('rejects arbitrary absolute paths outside the allowed roots', () =>
    Effect.gen(function* () {
      const openPdf = installOpener();
      const tool = new OpenPdfTool();

      const result = yield* tool.call({ path: fakePath('run/paper.pdf') }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            workingDirectory: fakePath('workspace'),
            run: {
              session: defaultSession(),
              runId: 'tool-test' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      );

      expectOpenError(result, 'Path must stay within the working directory');
      expect(openPdf).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.effect('rejects non-PDF files before invoking the host callback', () =>
    Effect.gen(function* () {
      const openPdf = installOpener();
      const tool = new OpenPdfTool();

      const result = yield* tool.call({ path: 'paper.tex' });

      expectOpenError(result, 'open_pdf only opens PDF files');
      expect(openPdf).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );
});
