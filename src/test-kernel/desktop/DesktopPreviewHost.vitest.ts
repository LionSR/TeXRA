import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import { withProcessServices } from '@platform/processRuntime';
import type { RunId } from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createModuleMocks } from '@test/support/moduleMocks';
import {
  createFakeWorkspaceRoots,
  FakeStateStore,
} from '@test/support/FakePlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import {
  makeTempDir as makeSharedTempDir,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { createExternalLocation } from '@utils/files/fileLocation';
import { createStubDesktopAgentRunHost } from './desktopAgentRunTestHarness.ts';

const mocks = createModuleMocks();

type FakeCompile = (location: { absolutePath: string }) => Effect.Effect<{
  ok: boolean;
  pdfPath?: string;
  logTail?: string;
}>;

/**
 * Stand-in LaTeX engine: succeeds and reports the PDF it "wrote" next to the
 * source, the way the real `compileLatex2Pdf` does.
 */
function fakeCompiler() {
  return vi.fn((location: { absolutePath: string }) =>
    Effect.succeed({
      ok: true,
      pdfPath: location.absolutePath.replace(/\.tex$/, '.pdf'),
    }),
  );
}

/** The paper a preview belongs to. */
const roots = createFakeWorkspaceRoots();

async function loadDesktopPreviewHost(
  compileLatex2Pdf: FakeCompile = fakeCompiler(),
  access?: (filePath: string) => Promise<void>,
  checkToolInstalled = vi.fn((): Effect.Effect<boolean> =>
    Effect.succeed(true),
  ),
): Promise<typeof import('@desktop/main/desktopPreviewHost')> {
  vi.resetModules();
  mocks.doMock('@latex/texTools', () => ({ compileLatex2Pdf }));
  mocks.doMock('@latex/latexToolchain', () => ({
    hasLatexCompiler: checkToolInstalled,
  }));
  if (access != null) {
    mocks.doMock('node:fs/promises', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:fs/promises')>()),
      access,
    }));
  }
  return import('@desktop/main/desktopPreviewHost');
}

function makeShell(openPathResult = '') {
  return {
    openExternal: vi.fn(async (_url: string) => {}),
    openPath: vi.fn(async (_path: string) => openPathResult),
  };
}

describe('desktop preview host', () => {
  const tempDirs = useTempDirs();

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  async function makeTempDir(): Promise<string> {
    return makeSharedTempDir('texra-preview-host-', tempDirs);
  }

  const TEX_SOURCE =
    '\\documentclass{article}\\begin{document}x\\end{document}';

  async function makeTexFixture(
    stem: string,
    { withPdf = true }: { withPdf?: boolean } = {},
  ): Promise<{ dir: string; texPath: string; pdfPath: string }> {
    const dir = await makeTempDir();
    const texPath = path.join(dir, `${stem}.tex`);
    const pdfPath = path.join(dir, `${stem}.pdf`);
    await writeFile(texPath, TEX_SOURCE);
    if (withPdf) await writeFile(pdfPath, 'pdf');
    return { dir, texPath, pdfPath };
  }

  it.effect.each([
    { kind: 'openFile', path: '/missing/output.pdf' },
    { kind: 'apiKeyBanner', action: 'guide' },
    { kind: 'extractFigures' },
    { kind: 'latexdiffs', action: 'compare' },
    { kind: 'exportTranscript', runId: 'missing:stream' as RunId },
    { kind: 'polish', text: 'A conserved quantity.' },
  ] satisfies HostRequest[])(
    'presents $kind failure once through the request dispatcher',
    (request) =>
      Effect.gen(function* () {
        const { createDesktopPreviewHost } = yield* Effect.promise(() =>
          loadDesktopPreviewHost(),
        );
        const { createDesktopHostRequests } = yield* Effect.promise(
          () => import('@desktop/main/desktopHostRequests'),
        );
        const { createFakeHost, installFakeHost } = yield* Effect.promise(
          () => import('@test/support/setupPlatform'),
        );
        const fakeHost = createFakeHost();
        yield* Effect.promise(() => installFakeHost(fakeHost));
        const secrets = fakeHost.secrets;
        const globalState = new FakeStateStore();
        const { createTestSession } = yield* Effect.promise(
          () => import('@test/support/sessionTestUtils'),
        );
        const { createHostSnapshotSource } = yield* Effect.promise(
          () => import('@controllers/session/hostSnapshotSource'),
        );
        const session = createTestSession();
        const present = vi.fn<(...args: unknown[]) => void>(() => {});
        const detachPresentation = yield* session.interactions.use({
          emit: present,
        });
        const { createDesktopFileSelection } = yield* Effect.promise(
          () => import('@desktop/main/desktopFileSelection'),
        );
        const { HostDraftRequests } = yield* Effect.promise(
          () => import('@controllers/session/hostDraftRequests'),
        );
        // After `vi.resetModules`, the refusal class the handler compares
        // against is this graph's instance, not the statically imported one.
        const { Rejected } = yield* Effect.promise(
          () => import('@shared/session/requestErrors'),
        );
        const showErrorMessage = vi.fn<
          (message: string) => Effect.Effect<void>
        >(() => Effect.void);
        const shell = makeShell();
        shell.openExternal.mockRejectedValue(new Error('Browser unavailable'));
        const preview = createDesktopPreviewHost({ shell });
        const draftRequests = new HostDraftRequests();
        vi.spyOn(draftRequests, 'handle').mockReturnValue(
          Effect.fail(new Rejected({ reason: 'Text service unavailable' })),
        );
        const files = createDesktopFileSelection({
          workspacePath: undefined,
          showOpenFileDialog: async () => undefined,
        });
        const handler = createDesktopHostRequests({
          runtime: testRuntime(),
          session,
          host: createStubDesktopAgentRunHost({
            ...preview,
            showErrorMessage,
          }),
          run: {} as Parameters<typeof createDesktopHostRequests>[0]['run'],
          files,
          secrets,
          globalState,
          snapshot: createHostSnapshotSource({
            project: {
              key: 'paper',
              name: 'Paper',
              initials: 'P',
              subtitle: '/paper',
            },
            secrets,
            stores: session.roots,
            fileOptions: () => files.fileOptions().pipe(Effect.orDie),
            readRecentCommits: () =>
              Effect.succeed({ commits: [], isGitRepo: false }),
            publish: () => Effect.void,
            onError: () => {},
          }),
          draftRequests,
          workspacePath: undefined,
          resourcesPath: '/resources',
          postToRenderer: () => {},
          postSurfaceAction: () => {},
          signIn: () => Effect.void,
          getCustomAgentDirectory: () => Effect.succeed('/agents'),
          showFirstRunWalkthrough: () => {},
          onboarding: {} as Parameters<
            typeof createDesktopHostRequests
          >[0]['onboarding'],
          openExternalUrl: preview.openExternal,
          recheckTools: () => Effect.void,
          logger: { warn: () => {}, error: () => {} },
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            handler.dispose();
            detachPresentation();
          }).pipe(Effect.andThen(() => session.dispose())),
        );
        const error = yield* Effect.flip(
          withProcessServices(
            testRuntime(),
            handler.handleHostRequest(request, 'window'),
          ),
        );
        expect(error).toBeDefined();
        expect(present).toHaveBeenCalledOnce();
        expect(present).toHaveBeenCalledWith('requestShowError', {
          message: expect.stringMatching(/\S/),
        });
        expect(showErrorMessage).not.toHaveBeenCalled();
        present.mockClear();
        const cancelled = yield* Effect.flip(
          withProcessServices(
            testRuntime(),
            handler.handleHostRequest(
              { kind: 'pickFiles', fileType: 'input' },
              'window',
            ),
          ),
        );
        expect(cancelled).toMatchObject({ _tag: 'Cancelled' });
        expect(present).not.toHaveBeenCalled();
      }),
  );

  it.effect('reports missing files before calling shell.openPath', () =>
    Effect.gen(function* () {
      const { createDesktopPreviewHost } = yield* Effect.promise(() =>
        loadDesktopPreviewHost(),
      );
      const missingPath = path.join(
        yield* Effect.promise(() => makeTempDir()),
        'missing.pdf',
      );
      const showErrorMessage = vi.fn((message: string) => Effect.void);
      const shell = makeShell();

      const host = createDesktopPreviewHost({ shell, showErrorMessage });

      const error = yield* Effect.flip(host.openPath(missingPath));
      expect(error.message).toContain(`File not found: ${missingPath}`);
      expect(showErrorMessage).toHaveBeenCalledWith(
        `File not found: ${missingPath}`,
      );
      expect(shell.openPath).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'preserves access failure details before calling shell.openPath',
    () =>
      Effect.gen(function* () {
        const accessError = Object.assign(new Error('permission denied'), {
          code: 'EACCES',
        });
        const access = vi.fn(async (_filePath: string) => {
          throw accessError;
        });
        const { createDesktopPreviewHost } = yield* Effect.promise(() =>
          loadDesktopPreviewHost(undefined, access),
        );
        const filePath = path.join(
          yield* Effect.promise(() => makeTempDir()),
          'blocked.pdf',
        );
        const showErrorMessage = vi.fn((message: string) => Effect.void);
        const shell = makeShell();

        const host = createDesktopPreviewHost({ shell, showErrorMessage });

        const error = yield* Effect.flip(host.openPath(filePath));
        expect(error.message).toContain(
          `Cannot access file ${filePath}: permission denied`,
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
          `Cannot access file ${filePath}: permission denied`,
        );
        expect(shell.openPath).not.toHaveBeenCalled();
      }),
  );

  it.effect('reports Electron shell.openPath errors once', () =>
    Effect.gen(function* () {
      const { createDesktopPreviewHost } = yield* Effect.promise(() =>
        loadDesktopPreviewHost(),
      );
      const dir = yield* Effect.promise(() => makeTempDir());
      const filePath = path.join(dir, 'blocked.pdf');
      yield* Effect.promise(() => writeFile(filePath, 'pdf'));
      const showErrorMessage = vi.fn((message: string) => Effect.void);
      const shell = makeShell('No associated application');

      const host = createDesktopPreviewHost({ shell, showErrorMessage });

      const error = yield* Effect.flip(host.openPath(filePath));
      expect(error.message).toContain(
        `Failed to open file ${filePath}: No associated application`,
      );
      expect(showErrorMessage).toHaveBeenCalledTimes(1);
      expect(showErrorMessage).toHaveBeenCalledWith(
        `Failed to open file ${filePath}: No associated application`,
      );
    }),
  );

  it.effect('builds LaTeX previews and opens the generated PDF path', () =>
    Effect.gen(function* () {
      const compileLatex2Pdf = fakeCompiler();
      const { createDesktopPreviewHost } = yield* Effect.promise(() =>
        loadDesktopPreviewHost(compileLatex2Pdf),
      );
      const { dir, texPath, pdfPath } = yield* Effect.promise(() =>
        makeTexFixture('preview'),
      );
      const shell = makeShell();

      const host = createDesktopPreviewHost({ shell });

      yield* host
        .openBuildDisplayIn(roots)(createExternalLocation(texPath))
        .pipe(Effect.provide(nodePlatformLayer));
      expect(compileLatex2Pdf).toHaveBeenCalledWith(
        expect.objectContaining({ absolutePath: texPath }),
        roots,
        { outputDirectory: dir },
      );
      expect(shell.openPath).toHaveBeenCalledWith(pdfPath);
    }),
  );

  it.effect('opens compile-preview PDF targets without running LaTeX', () =>
    Effect.gen(function* () {
      const compileLatex2Pdf = fakeCompiler();
      const checkToolInstalled = vi.fn((): Effect.Effect<boolean> =>
        Effect.succeed(true),
      );
      const { createDesktopPreviewHost } = yield* Effect.promise(() =>
        loadDesktopPreviewHost(compileLatex2Pdf, undefined, checkToolInstalled),
      );
      const dir = yield* Effect.promise(() => makeTempDir());
      const pdfPath = path.join(dir, 'preview.pdf');
      yield* Effect.promise(() => writeFile(pdfPath, 'pdf'));
      const shell = makeShell();

      const host = createDesktopPreviewHost({ shell });

      yield* host
        .openBuildDisplayIn(roots)(createExternalLocation(pdfPath))
        .pipe(Effect.provide(nodePlatformLayer));
      expect(compileLatex2Pdf).not.toHaveBeenCalled();
      expect(checkToolInstalled).not.toHaveBeenCalled();
      expect(shell.openPath).toHaveBeenCalledWith(pdfPath);
    }),
  );

  it.effect(
    'reports missing LaTeX toolchains before compiling preview sources',
    () =>
      Effect.gen(function* () {
        const compileLatex2Pdf = fakeCompiler();
        const checkToolInstalled = vi.fn((): Effect.Effect<boolean> =>
          Effect.succeed(false),
        );
        const { createDesktopPreviewHost } = yield* Effect.promise(() =>
          loadDesktopPreviewHost(
            compileLatex2Pdf,
            undefined,
            checkToolInstalled,
          ),
        );
        const { texPath } = yield* Effect.promise(() =>
          makeTexFixture('preview', { withPdf: false }),
        );
        const showErrorMessage = vi.fn(() => Effect.void);
        const shell = makeShell();

        const host = createDesktopPreviewHost({ shell, showErrorMessage });

        const message = `No LaTeX compiler found for ${texPath}. Install latexmk or pdflatex to compile and preview this file.`;
        const error = yield* Effect.flip(
          host
            .openBuildDisplayIn(roots)(createExternalLocation(texPath))
            .pipe(Effect.provide(nodePlatformLayer)),
        );
        expect(toErrorMessage(error)).toContain(message);
        expect(showErrorMessage).toHaveBeenCalledWith(message);
        expect(compileLatex2Pdf).not.toHaveBeenCalled();
        expect(shell.openPath).not.toHaveBeenCalled();
      }),
  );

  it.effect('reports LaTeX build failures without opening stale PDFs', () =>
    Effect.gen(function* () {
      const logTail = 'simulated compile log tail';
      const compileLatex2Pdf = vi.fn(() =>
        Effect.succeed({ ok: false, logTail }),
      );
      const { createDesktopPreviewHost } = yield* Effect.promise(() =>
        loadDesktopPreviewHost(compileLatex2Pdf),
      );
      const { texPath } = yield* Effect.promise(() =>
        makeTexFixture('preview', { withPdf: false }),
      );
      const showErrorMessage = vi.fn(() => Effect.void);
      const shell = makeShell();
      // Silence and inspect the console.error the full log tail is routed to
      // instead of the (short) dialog message -- see the desktop preview host's
      // fail() call, which must not stuff the full engine log into a native
      // dialog.showMessageBox modal.
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const host = createDesktopPreviewHost({ shell, showErrorMessage });

      const message = `LaTeX build failed for ${texPath}. See the LaTeX log next to the source for details.`;
      const error = yield* Effect.flip(
        host
          .openBuildDisplayIn(roots)(createExternalLocation(texPath))
          .pipe(Effect.provide(nodePlatformLayer)),
      );
      expect(toErrorMessage(error)).toContain(message);
      expect(showErrorMessage).toHaveBeenCalledWith(message);
      expect(showErrorMessage).not.toHaveBeenCalledWith(
        expect.stringContaining(logTail),
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(logTail),
      );
      expect(shell.openPath).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    'can preserve an external-open error without showing a dialog',
    () =>
      Effect.gen(function* () {
        const { createDesktopPreviewHost } = yield* Effect.promise(() =>
          loadDesktopPreviewHost(),
        );
        const browserError = new Error('no browser handler');
        const shell = makeShell();
        shell.openExternal.mockRejectedValueOnce(browserError);
        const showErrorMessage = vi.fn(() => Effect.void);

        const host = createDesktopPreviewHost({ shell, showErrorMessage });

        const error = yield* Effect.flip(
          host.openExternal('https://auth.openai.com/authorize', {
            reportFailure: false,
          }),
        );
        expect(error).toBe(browserError);
        expect(showErrorMessage).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'prefers the in-app PDF overlay when postToRenderer accepts the post',
    () =>
      Effect.gen(function* () {
        const { createDesktopPreviewHost } = yield* Effect.promise(() =>
          loadDesktopPreviewHost(),
        );
        const { texPath, pdfPath } = yield* Effect.promise(() =>
          makeTexFixture('paper'),
        );
        const shell = makeShell();
        const postToRenderer = vi.fn((_message: unknown) => true);

        const host = createDesktopPreviewHost({ shell, postToRenderer });

        yield* host
          .openBuildDisplayIn(roots)(createExternalLocation(texPath))
          .pipe(Effect.provide(nodePlatformLayer));
        expect(postToRenderer).toHaveBeenCalledTimes(1);
        expect(postToRenderer).toHaveBeenCalledWith(
          expect.objectContaining({
            command: 'desktop:showPdf',
            title: 'paper.pdf',
            pdfPath,
          }),
        );
        expect(shell.openPath).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    'falls back to external viewer when postToRenderer returns false',
    () =>
      Effect.gen(function* () {
        const { createDesktopPreviewHost } = yield* Effect.promise(() =>
          loadDesktopPreviewHost(),
        );
        const { texPath, pdfPath } = yield* Effect.promise(() =>
          makeTexFixture('paper'),
        );
        const shell = makeShell();
        const postToRenderer = vi.fn((_message: unknown) => false);

        const host = createDesktopPreviewHost({ shell, postToRenderer });

        yield* host
          .openBuildDisplayIn(roots)(createExternalLocation(texPath))
          .pipe(Effect.provide(nodePlatformLayer));
        expect(postToRenderer).toHaveBeenCalledTimes(1);
        expect(shell.openPath).toHaveBeenCalledWith(pdfPath);
      }),
  );

  it.effect('falls back to external viewer when postToRenderer throws', () =>
    Effect.gen(function* () {
      const { createDesktopPreviewHost } = yield* Effect.promise(() =>
        loadDesktopPreviewHost(),
      );
      const { texPath, pdfPath } = yield* Effect.promise(() =>
        makeTexFixture('paper'),
      );
      const shell = makeShell();
      const postToRenderer = vi.fn((_message: unknown) => {
        throw new Error('IPC bridge not ready');
      });
      // Silence the expected console.error so the test output is clean.
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const host = createDesktopPreviewHost({ shell, postToRenderer });

      yield* host
        .openBuildDisplayIn(roots)(createExternalLocation(texPath))
        .pipe(Effect.provide(nodePlatformLayer));
      expect(postToRenderer).toHaveBeenCalledTimes(1);
      expect(shell.openPath).toHaveBeenCalledWith(pdfPath);
    }),
  );
});
