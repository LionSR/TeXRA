import { access, writeFile } from 'node:fs/promises';

import { it } from '@effect/vitest';
import {
  Effect,
  Fiber,
  type FileSystem,
  type Path,
  Stream,
  SubscriptionRef,
} from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

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
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

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

describe('desktop tool edit approval', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.live(
    'applies user edits made in the proposed preview file',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { requestToolEditApproval, controllerModule, desktopModule } =
            yield* Effect.tryPromise(async () => {
              vi.resetModules();
              const { installPlatform } =
                await import('@test/support/setupPlatform');
              await installPlatform({ workspacePath: '/workspace' });
              await import('@test/support/sessionGraphTestSetup');
              const [approval, controllerModule, desktopModule] =
                await Promise.all([
                  import('@tools/approval/toolEditApproval'),
                  import('@texra/controllers/approval/ToolEditApprovalController'),
                  import('@desktop/main/desktopToolEditApproval'),
                ]);
              return {
                requestToolEditApproval: approval.requestToolEditApproval,
                controllerModule,
                desktopModule,
              };
            });
          const session = yield* createTestSession();
          yield* Effect.addFinalizer(() => closeSessionOf(session));
          const opened: string[] = [];
          const host = new desktopModule.DesktopToolEditApprovalHost({
            spawn: (program) => {
              testRuntime().runFork(program);
            },
            ui: {
              openPath: (filePath) =>
                Effect.sync(() => {
                  opened.push(filePath);
                }),
              openBuildDisplay: () => Effect.void,
              openDiff: () => Effect.void,
              showErrorMessage: () => Effect.void,
              closeDiff: () => Effect.void,
            },
          });
          // The previews the host actually staged. `stagePreview` hands back
          // a program, so the spy's recorded results are descriptions; what
          // each program produces is collected as it produces it instead.
          const staged: ToolEditPreview[] = [];
          const stageOnHost = host.stagePreview.bind(host);
          const stagePreview = vi
            .spyOn(host, 'stagePreview')
            .mockImplementation((request, context) =>
              stageOnHost(request, context).pipe(
                Effect.tap((preview) =>
                  Effect.sync(() => staged.push(preview)),
                ),
              ),
            );
          const controller = new controllerModule.ToolEditApprovalController({
            host,
            session: testSessionOf(session),
          });
          yield* Effect.addFinalizer(() =>
            onRuntime(controller.dispose()).pipe(Effect.orDie),
          );
          yield* Effect.forkScoped(
            Stream.runForEach(session.log.tail(session.log.now()), (event) =>
              onRuntime(controller.handleSessionEvent(event)),
            ),
          );
          // The attached host stages the preview the durable payload cannot carry.
          const detach = yield* session.interactions.use({
            presentToolEdit: (request) => {
              testRuntime().runFork(controller.present(request));
            },
          });
          yield* Effect.addFinalizer(() => Effect.sync(detach));

          // A request row is only ever appended to a run the history knows.
          const runId = 'a40000' as RunId;
          publishTestRunStart(session, runId);
          yield* session.log.settled;
          const result = yield* Effect.forkScoped(
            requestToolEditApproval({
              path: '/workspace/notes.txt',
              originalContent: 'alpha\n',
              proposedContent: 'beta\n',
              sourceTool: 'write_file',
              runId,
            }).pipe(
              Effect.provide(
                nativeToolTestLayer({
                  roots: createFakeWorkspaceRoots({
                    workspacePath: '/workspace',
                  }),
                  workingDirectory: '/workspace',
                  run: { runId, session, toolPolicy: {} },
                }),
              ),
            ),
          );
          // Staged on the host and listed by the fold, where a surface's
          // decision finds it.
          yield* Effect.tryPromise(() =>
            vi.waitFor(() => {
              expect(staged).toHaveLength(1);
              expect(
                SubscriptionRef.getUnsafe(session.view.ref).requests,
              ).toHaveLength(1);
            }, 10_000),
          );
          const { requestId } = stagePreview.mock.calls[0]![0].permission;

          yield* onRuntime(
            controller.handleAction({ requestId, action: 'previewProposed' }),
          );
          yield* Effect.tryPromise(() =>
            vi.waitFor(() => expect(opened).toHaveLength(1)),
          );
          yield* Effect.tryPromise(() =>
            writeFile(opened[0], 'beta\nwith user edits\nand more\n', 'utf8'),
          );
          yield* onRuntime(
            controller.handleAction({ requestId, action: 'approve' }),
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
      ),
    30_000,
  );
});
