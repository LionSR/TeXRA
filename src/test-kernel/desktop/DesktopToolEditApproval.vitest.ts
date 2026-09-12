import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Fiber, Scope, Stream, SubscriptionRef } from 'effect';
import { afterEach, describe, expect, onTestFinished, vi } from 'vitest';

import type { DesktopAgentRunHost } from '@desktop/main/desktopAgentRunHost';
import type { DiffSource } from '@hosts/uiHosts';

import type { RunId } from '@shared/schemas';
import { createModuleMocks } from '@test/support/moduleMocks';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import {
  createStubDesktopAgentRunHost,
  disposeAfterTest,
} from './desktopAgentRunTestHarness.ts';
import { loadSourceModule } from './loadSourceModule.ts';

const approvalTest = (
  name: string,
  fn: () => Effect.Effect<void, unknown, Scope.Scope>,
): void => {
  it.live(name, () => Effect.scoped(fn()), 30_000);
};

const mocks = createModuleMocks();

async function createTempRoot(prefix = 'texra-approval-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadApprovalModules(workspacePath = '/workspace') {
  vi.resetModules();
  type MockLocation =
    | { kind: 'workspace'; absolutePath: string; relativePath: string }
    | { kind: 'external'; absolutePath: string };
  const toMockLocation = (filePath: string): MockLocation => {
    if (!path.isAbsolute(filePath)) {
      return {
        kind: 'workspace',
        absolutePath: path.join(workspacePath, filePath),
        relativePath: filePath,
      };
    }
    if (filePath.startsWith(`${workspacePath}/`)) {
      return {
        kind: 'workspace',
        absolutePath: filePath,
        relativePath: filePath.slice(`${workspacePath}/`.length),
      };
    }
    return { kind: 'external', absolutePath: filePath };
  };
  mocks.doMock('@utils/config/configUtils', () => ({
    getConfig: vi.fn(() => 'sameDirectory'),
    getConfigBeforePlatformInit: vi.fn(
      <T>(_path: string, defaultValue: T) => defaultValue,
    ),
    getValidatedConfig: vi.fn(
      <T>(_path: string, _schema: unknown, defaultValue: T) => defaultValue,
    ),
  }));
  mocks.doMock('@utils/files/workspaceFS', async () => {
    const actual = await vi.importActual<
      typeof import('@utils/files/workspaceFS')
    >('@utils/files/workspaceFS');
    return {
      ...actual,
      WorkspaceFS: {
        getPath(): string {
          return workspacePath;
        },
        relativePath(filePath: string): string {
          return filePath.startsWith(`${workspacePath}/`)
            ? filePath.slice(`${workspacePath}/`.length)
            : filePath;
        },
        locatePath(filePath: string): MockLocation {
          return toMockLocation(filePath);
        },
      },
      pathToLocation(filePath: string): MockLocation {
        return toMockLocation(filePath);
      },
    };
  });

  const [{ installPlatform }, { nodeFilesystem }] = await Promise.all([
    import('@test/support/setupPlatform'),
    import('@platform/defaults/nodeFilesystem'),
  ]);
  await installPlatform({ workspacePath }, { fs: nodeFilesystem });
  await import('@test/support/sessionGraphTestSetup');

  const [{ requestToolEditApproval }, controllerModule, desktopModule] =
    await Promise.all([
      import('@tools/approval/toolEditApproval'),
      import('@controllers/approval/ToolEditApprovalController'),
      loadSourceModule('@desktop/main/desktopToolEditApproval'),
    ]);
  return {
    requestToolEditApproval,
    controllerModule,
    desktopModule,
  };
}

/** A controller with real staged previews and an isolated session. */
function createApprovalFixture(
  options: {
    ui?: DesktopAgentRunHost;
    workspacePath?: string;
  } = {},
) {
  return Effect.gen(function* () {
    const modules = yield* Effect.tryPromise(() =>
      loadApprovalModules(options.workspacePath),
    );
    const session = createTestSession();
    yield* Effect.addFinalizer(() => Effect.sync(() => session.dispose()));
    const host = new modules.desktopModule.DesktopToolEditApprovalHost({
      ui: options.ui ?? createStubDesktopAgentRunHost(),
      // The desktop surface's decision: the session's one `request.decide`.
      decide: (runId, requestId, decision) =>
        Effect.runPromise(
          session.requests
            .request({ kind: 'request.decide', runId, requestId, decision })
            .pipe(Effect.asVoid),
        ),
    });
    const stagePreview = vi.spyOn(host, 'stagePreview');
    const controller = new modules.controllerModule.ToolEditApprovalController({
      host,
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.dispose()));
    yield* Effect.forkScoped(
      Stream.runForEach(session.events.all(session.now()), (event) =>
        Effect.sync(() => controller.handleSessionEvent(event)),
      ),
    );
    // The attached host stages the preview the durable payload cannot carry.
    const detach = session.interactions.use({
      presentToolEdit: (request) => {
        void controller.present(request);
      },
    });
    yield* Effect.addFinalizer(() => Effect.sync(detach));
    const started = new Set<RunId>();
    return {
      ...modules,
      controller,
      session,
      /**
       * Ask for one edit through the tool boundary, as a tool call does. The
       * run's existence fact comes first: a request row is only ever appended
       * to a run the ledger already knows.
       */
      requestApproval(request: Omit<ToolEditApprovalRequest, 'permission'>) {
        const { runId } = request;
        return Effect.gen(function* () {
          if (!runId)
            return yield* Effect.fail(
              new Error('Test request needs a run id.'),
            );
          if (!started.has(runId)) {
            started.add(runId);
            publishTestRunStart(session, runId);
            yield* Effect.tryPromise(() => session.settlePublications());
          }
          return yield* modules.requestToolEditApproval(request).pipe(
            Effect.provide(
              nativeToolTestLayer({
                workingDirectory: options.workspacePath ?? '/workspace',
                run: { runId, session, toolPolicy: {} },
              }),
            ),
          );
        });
      },
      /** Waits until every staged preview's directory has been removed. */
      waitForStagedCleanup() {
        return Effect.tryPromise(() =>
          vi.waitFor(async () => {
            const previews = await Promise.all(
              stagePreview.mock.results.map(({ value }) => value),
            );
            for (const preview of previews)
              await expect(
                pathExists(path.dirname(preview.proposedPath)),
              ).resolves.toBe(false);
          }),
        );
      },
      /**
       * Wait until `count` requests are both staged on the host and listed by
       * the fold, which is where a surface's decision finds them.
       */
      waitForPreviews(count = 1) {
        return Effect.tryPromise(async () => {
          await vi.waitFor(() => {
            expect(stagePreview).toHaveBeenCalledTimes(count);
            expect(
              SubscriptionRef.getUnsafe(session.view).requests,
            ).toHaveLength(count);
          });
          await Promise.all(
            stagePreview.mock.results.map(({ value }) => value),
          );
          return stagePreview.mock.calls.map(([request]) => request.permission);
        });
      },
    };
  });
}

describe('desktop tool edit approval', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  approvalTest('approves pending edits only in the selected run', () =>
    Effect.gen(function* () {
      const { controller, requestApproval, waitForPreviews } =
        yield* createApprovalFixture();

      const target = yield* Effect.forkScoped(
        requestApproval({
          path: '/workspace/target.txt',
          originalContent: 'old target\n',
          proposedContent: 'new target\n',
          sourceTool: 'write_file',
          runId: 'a0b0c0' as RunId,
        }),
      );
      const other = yield* Effect.forkScoped(
        requestApproval({
          path: '/workspace/other.txt',
          originalContent: 'old other\n',
          proposedContent: 'new other\n',
          sourceTool: 'write_file',
          runId: 'd0e0f0' as RunId,
        }),
      );
      const requests = yield* waitForPreviews(2);

      yield* Effect.tryPromise(() =>
        controller.approvePendingForRun('a0b0c0' as RunId),
      );
      expect(yield* Fiber.join(target)).toMatchObject({
        action: 'apply',
        appliedContent: 'new target\n',
      });

      const otherRequest = requests.find(
        (request) => request.runId === 'd0e0f0',
      );
      expect(otherRequest).toBeDefined();
      controller.handleAction({
        requestId: otherRequest!.requestId,
        action: 'reject',
      });
      expect(yield* Fiber.join(other)).toMatchObject({ action: 'reject' });
    }),
  );

  approvalTest(
    'routes proposed-file previews through desktop temp files before rejection',
    () =>
      Effect.gen(function* () {
        const opened: string[] = [];
        const { requestApproval, controller, waitForPreviews } =
          yield* createApprovalFixture({
            ui: createStubDesktopAgentRunHost({
              openPath: async (filePath) => {
                opened.push(filePath);
              },
            }),
          });

        const result = yield* Effect.forkScoped(
          requestApproval({
            path: '/workspace/notes.txt',
            originalContent: 'alpha\n',
            proposedContent: 'beta\n',
            sourceTool: 'write_file',
            runId: 'a20000' as RunId,
          }),
        );
        const [request] = yield* waitForPreviews();

        controller.handleAction({
          requestId: request.requestId,
          action: 'previewProposed',
        });
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => expect(opened).toHaveLength(1)),
        );
        expect(path.basename(opened[0])).toContain('proposed');
        expect(yield* Effect.tryPromise(() => pathExists(opened[0]))).toBe(
          true,
        );

        controller.handleAction({
          requestId: request.requestId,
          action: 'reject',
          feedback: 'not yet',
        });
        expect(yield* Fiber.join(result)).toMatchObject({
          action: 'reject',
          feedback: 'not yet',
        });
        yield* Effect.tryPromise(() =>
          vi.waitFor(async () => {
            await expect(pathExists(opened[0])).resolves.toBe(false);
          }),
        );
      }),
  );

  approvalTest(
    'routes diff actions through the required desktop diff host',
    () =>
      Effect.gen(function* () {
        const openPath = vi.fn(async (_filePath: string) => {});
        const openDiff = vi.fn(
          async (
            _original: DiffSource,
            _proposed: DiffSource,
            _title: string,
          ): Promise<void> => undefined,
        );
        const { requestApproval, controller, waitForPreviews } =
          yield* createApprovalFixture({
            ui: createStubDesktopAgentRunHost({ openPath, openDiff }),
          });

        const result = yield* Effect.forkScoped(
          requestApproval({
            path: '/workspace/main.tex',
            originalContent: 'old\n',
            proposedContent: 'new\n',
            sourceTool: 'write_file',
            runId: 'a30000' as RunId,
          }),
        );
        const [request] = yield* waitForPreviews();
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => expect(openDiff).toHaveBeenCalledOnce()),
        );

        controller.handleAction({
          requestId: request.requestId,
          action: 'openDiff',
        });

        yield* Effect.tryPromise(() =>
          vi.waitFor(() => expect(openDiff).toHaveBeenCalledTimes(2)),
        );
        expect(openPath).not.toHaveBeenCalled();
        const [original, proposed, title] = openDiff.mock.calls[0];
        expect(title).toBe('Tool edit: main.tex');
        expect(
          yield* Effect.tryPromise(() => pathExists(original.filePath)),
        ).toBe(true);
        expect(
          yield* Effect.tryPromise(() => pathExists(proposed.filePath)),
        ).toBe(true);

        controller.handleAction({
          requestId: request.requestId,
          action: 'reject',
        });
        expect(yield* Fiber.join(result)).toMatchObject({ action: 'reject' });
      }),
  );

  approvalTest('applies user edits made in the proposed preview file', () =>
    Effect.gen(function* () {
      const opened: string[] = [];
      const { requestApproval, controller, waitForPreviews } =
        yield* createApprovalFixture({
          ui: createStubDesktopAgentRunHost({
            openPath: async (filePath) => {
              opened.push(filePath);
            },
          }),
        });

      const result = yield* Effect.forkScoped(
        requestApproval({
          path: '/workspace/notes.txt',
          originalContent: 'alpha\n',
          proposedContent: 'beta\n',
          sourceTool: 'write_file',
          runId: 'a40000' as RunId,
        }),
      );
      const [request] = yield* waitForPreviews();

      controller.handleAction({
        requestId: request.requestId,
        action: 'previewProposed',
      });
      yield* Effect.tryPromise(() =>
        vi.waitFor(() => expect(opened).toHaveLength(1)),
      );
      yield* Effect.tryPromise(() =>
        writeFile(opened[0], 'beta\nwith user edits\nand more\n', 'utf8'),
      );

      controller.handleAction({
        requestId: request.requestId,
        action: 'approve',
      });

      expect(yield* Fiber.join(result)).toMatchObject({
        action: 'apply',
        appliedContent: 'beta\nwith user edits\nand more\n',
        lineChanges: { added: 3, removed: 1 },
      });
      yield* Effect.tryPromise(() =>
        vi.waitFor(async () => {
          await expect(pathExists(opened[0])).resolves.toBe(false);
        }),
      );
    }),
  );

  approvalTest(
    'reports a failed preview read and accepts a later approval',
    () =>
      Effect.gen(function* () {
        const opened: string[] = [];
        const messages: string[] = [];
        const { requestApproval, controller, waitForPreviews } =
          yield* createApprovalFixture({
            ui: createStubDesktopAgentRunHost({
              openPath: async (filePath) => {
                opened.push(filePath);
              },
              showErrorMessage: (message) => {
                messages.push(message);
              },
            }),
          });

        const result = yield* Effect.forkScoped(
          requestApproval({
            path: '/workspace/notes.txt',
            originalContent: 'alpha\n',
            proposedContent: 'beta\n',
            sourceTool: 'write_file',
            runId: 'a50000' as RunId,
          }),
        );
        const [request] = yield* waitForPreviews();
        const { requestId } = request;

        controller.handleAction({ requestId, action: 'previewProposed' });
        yield* Effect.tryPromise(() =>
          vi.waitFor(() => expect(opened).toHaveLength(1)),
        );
        yield* Effect.tryPromise(() => rm(opened[0]));

        controller.handleAction({ requestId, action: 'approve' });

        yield* Effect.tryPromise(() =>
          vi.waitFor(() => expect(messages).toHaveLength(1)),
        );
        expect(messages[0]).toContain('edited document could not be read');

        yield* Effect.tryPromise(() =>
          writeFile(opened[0], 'beta after retry\r\n', 'utf8'),
        );
        controller.handleAction({ requestId, action: 'approve' });

        expect(yield* Fiber.join(result)).toMatchObject({
          action: 'apply',
          appliedContent: 'beta after retry\n',
        });
      }),
  );

  approvalTest(
    'routes LaTeX diff inspection without settling the request',
    () =>
      Effect.gen(function* () {
        const runLatexdiff = vi.fn(async () => {});
        mocks.doMock('@tools/approval/latexPreview', async () => {
          const actual = await vi.importActual<
            typeof import('@tools/approval/latexPreview')
          >('@tools/approval/latexPreview');
          return { ...actual, runLatexdiff };
        });

        const openBuildDisplay = vi.fn(async () => {});
        const { requestApproval, controller, waitForPreviews } =
          yield* createApprovalFixture({
            ui: createStubDesktopAgentRunHost({ openBuildDisplay }),
          });

        const result = yield* Effect.forkScoped(
          requestApproval({
            path: '/workspace/main.tex',
            originalContent: 'old\n',
            proposedContent: 'new\n',
            sourceTool: 'write_file',
            runId: 'a60000' as RunId,
          }),
        );
        const [request] = yield* waitForPreviews();

        controller.handleAction({
          requestId: request.requestId,
          action: 'showLatexdiff',
        });

        yield* Effect.tryPromise(() =>
          vi.waitFor(() => expect(runLatexdiff).toHaveBeenCalledOnce()),
        );
        expect(runLatexdiff).toHaveBeenCalledWith(
          expect.objectContaining({ requestId: request.requestId }),
          {
            subtype: 'ONLYCHANGEDPAGE',
            openBuildDisplay,
          },
        );
        expect(result.pollUnsafe()).toBeUndefined();

        controller.handleAction({
          requestId: request.requestId,
          action: 'reject',
        });
        expect(yield* Fiber.join(result)).toMatchObject({ action: 'reject' });
      }),
  );

  approvalTest(
    'uses the injected desktop build display callback for LaTeX preview',
    () =>
      Effect.gen(function* () {
        const workspaceRoot = yield* Effect.tryPromise(() =>
          createTempRoot('texra-workspace-'),
        );
        const displayed: Array<{
          absolutePath: string;
          options?: { preserveFocus?: boolean };
        }> = [];
        const messages: string[] = [];
        const { requestApproval, controller, waitForPreviews } =
          yield* createApprovalFixture({
            workspacePath: workspaceRoot,
            ui: createStubDesktopAgentRunHost({
              openBuildDisplay: async (location, options) => {
                displayed.push({
                  absolutePath: location.absolutePath,
                  options,
                });
              },
              showErrorMessage: (message) => {
                messages.push(message);
              },
            }),
          });

        const result = yield* Effect.forkScoped(
          requestApproval({
            path: path.join(workspaceRoot, 'main.tex'),
            originalContent:
              '\\documentclass{article}\\begin{document}old\\end{document}\n',
            proposedContent:
              '\\documentclass{article}\\begin{document}new\\end{document}\n',
            sourceTool: 'write_file',
            runId: 'a70000' as RunId,
          }),
        );
        const [request] = yield* waitForPreviews();

        controller.handleAction({
          requestId: request.requestId,
          action: 'previewProposed',
        });

        yield* Effect.tryPromise(() =>
          vi.waitFor(() => {
            expect([...displayed, ...messages]).toHaveLength(1);
          }),
        );
        expect(messages).toEqual([]);
        expect(displayed[0].options).toEqual({ preserveFocus: true });
        expect(path.basename(displayed[0].absolutePath)).toMatch(
          /^main_preview-[\w-]{8}\.tex$/,
        );
        expect(
          yield* Effect.tryPromise(() => pathExists(displayed[0].absolutePath)),
        ).toBe(true);

        // The request's own decision releases the preview and everything the
        // LaTeX inspection staged beside it.
        controller.handleAction({
          requestId: request.requestId,
          action: 'reject',
        });
        expect(yield* Fiber.join(result)).toMatchObject({ action: 'reject' });
        yield* Effect.tryPromise(() =>
          vi.waitFor(async () => {
            await expect(pathExists(displayed[0].absolutePath)).resolves.toBe(
              false,
            );
          }),
        );
      }),
  );

  approvalTest(
    'releases every staged preview when the controller is disposed',
    () =>
      Effect.gen(function* () {
        const {
          requestApproval,
          controller,
          waitForPreviews,
          waitForStagedCleanup,
        } = yield* createApprovalFixture();

        yield* Effect.forkScoped(
          requestApproval({
            path: '/workspace/disposed.tex',
            originalContent: 'old\n',
            proposedContent: 'new\n',
            sourceTool: 'write_file',
            runId: 'a80000' as RunId,
          }),
        );
        yield* waitForPreviews();

        controller.dispose();

        yield* waitForStagedCleanup();
      }),
  );
});
