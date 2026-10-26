import { access, writeFile } from 'node:fs/promises';

import { it } from '@effect/vitest';
import {
  Effect,
  Fiber,
  type FileSystem,
  type Path,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import type { DesktopToolEditApprovalUi } from '@desktop/main/desktopToolEditApproval';
import type { RunId } from '@shared/schemas';
import { testSessionOf, testRuntime } from '@test/support/testProcessRuntime';
import { closeSessionOf } from '@test/support/sessionEnd';

import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import type { ToolEditPreview } from '@texra/controllers/approval/ToolEditApprovalController';
import type * as ToolEditApproval from '@tools/approval/toolEditApproval';
import { createStubDesktopAgentRunHost } from './desktopAgentRunTestHarness.ts';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

const approvalTest = (
  name: string,
  fn: () => Effect.Effect<void, unknown, Scope.Scope>,
): void => {
  it.live(name, () => Effect.scoped(fn()), 30_000);
};

/**
 * The host wiring point's run. The controller's verbs are Effects and it
 * holds no runtime of its own; a desktop window hands them its process
 * runtime, and so does this suite.
 */
const onRuntime = <A, E>(
  program: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner
  >,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({
    try: () => testRuntime().runPromise(program),
    catch: (error) => error,
  });

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
  const { installPlatform } = await import('@test/support/setupPlatform');
  await installPlatform({ workspacePath });
  await import('@test/support/sessionGraphTestSetup');

  const [{ requestToolEditApproval }, controllerModule, desktopModule] =
    await Promise.all([
      import('@tools/approval/toolEditApproval'),
      import('@texra/controllers/approval/ToolEditApprovalController'),
      import('@desktop/main/desktopToolEditApproval'),
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
    ui?: Partial<DesktopToolEditApprovalUi>;
    workspacePath?: string;
  } = {},
) {
  return Effect.gen(function* () {
    const modules = yield* Effect.tryPromise(() =>
      loadApprovalModules(options.workspacePath),
    );
    const session = yield* createTestSession();
    yield* Effect.addFinalizer(() => closeSessionOf(session));
    const host = new modules.desktopModule.DesktopToolEditApprovalHost({
      spawn: (program) => {
        testRuntime().runFork(program);
      },
      ui: {
        ...createStubDesktopAgentRunHost(),
        closeDiff: () => Effect.void,
        ...options.ui,
      },
    });
    // The previews the host actually staged. `stagePreview` hands back a
    // program now, not a promise, so the spy's recorded results are
    // descriptions: running one again would stage a second set of temp files.
    // What each program produces is collected as it produces it instead.
    const staged: ToolEditPreview[] = [];
    const stageOnHost = host.stagePreview.bind(host);
    const stagePreview = vi
      .spyOn(host, 'stagePreview')
      .mockImplementation((request, context) =>
        stageOnHost(request, context).pipe(
          Effect.tap((preview) => Effect.sync(() => staged.push(preview))),
        ),
      );
    const controller = new modules.controllerModule.ToolEditApprovalController({
      host,
      session: testSessionOf(session),
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => testRuntime().runPromise(controller.dispose())),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(session.log.tail(session.log.now()), (event) =>
        onRuntime(controller.handleSessionEvent(event)),
      ),
    );
    // The attached host stages the preview the durable payload cannot carry.
    const detach = Effect.runSync(
      session.interactions.use({
        presentToolEdit: (request) => {
          testRuntime().runFork(controller.present(request));
        },
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(detach));
    const started = new Set<RunId>();
    return {
      ...modules,
      controller,
      session,
      /**
       * Ask for one edit through the tool boundary, as a tool call does. The
       * run's existence fact comes first: a request row is only ever appended
       * to a run the run history already knows.
       */
      requestApproval(
        request: Parameters<typeof ToolEditApproval.requestToolEditApproval>[0],
      ) {
        const { runId } = request;
        return Effect.gen(function* () {
          if (!runId)
            return yield* Effect.fail(
              new Error('Test request needs a run id.'),
            );
          if (!started.has(runId)) {
            started.add(runId);
            publishTestRunStart(session, runId);
            yield* session.log.settled;
          }
          return yield* modules.requestToolEditApproval(request).pipe(
            Effect.provide(
              nativeToolTestLayer({
                // The run's roots, as a dispatched tool call carries them. The
                // workspace is this suite's own: its resolution is mocked to
                // `/workspace`, and the display path an edit is titled with is
                // relative to the call's root.
                roots: createFakeWorkspaceRoots({
                  workspacePath: options.workspacePath ?? '/workspace',
                }),
                workingDirectory: options.workspacePath ?? '/workspace',
                run: { runId, session, toolPolicy: {} },
              }),
            ),
          );
        });
      },
      /**
       * Wait until `count` requests are both staged on the host and listed by
       * the fold, which is where a surface's decision finds them.
       */
      waitForPreviews(count = 1) {
        return Effect.tryPromise(async () => {
          await vi.waitFor(() => {
            expect(stagePreview).toHaveBeenCalledTimes(count);
            expect(staged).toHaveLength(count);
            expect(
              SubscriptionRef.getUnsafe(session.view.ref).requests,
            ).toHaveLength(count);
            // The first staging pays the cold module graph; a loaded shard
            // stages slower than the default second.
          }, 10_000);
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

  approvalTest('applies user edits made in the proposed preview file', () =>
    Effect.gen(function* () {
      const opened: string[] = [];
      const { requestApproval, controller, waitForPreviews } =
        yield* createApprovalFixture({
          ui: createStubDesktopAgentRunHost({
            openPath: (filePath) =>
              Effect.sync(() => {
                opened.push(filePath);
              }),
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

      yield* onRuntime(
        controller.handleAction({
          requestId: request.requestId,
          action: 'previewProposed',
        }),
      );
      yield* Effect.tryPromise(() =>
        vi.waitFor(() => expect(opened).toHaveLength(1)),
      );
      yield* Effect.tryPromise(() =>
        writeFile(opened[0], 'beta\nwith user edits\nand more\n', 'utf8'),
      );

      yield* onRuntime(
        controller.handleAction({
          requestId: request.requestId,
          action: 'approve',
        }),
      );

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
});
