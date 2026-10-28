import { access, writeFile } from 'node:fs/promises';

import { it } from '@effect/vitest';
import {
  Effect,
  Fiber,
  type FileSystem,
  type Path,
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
    'applies the edit a closed window made when another window approves',
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
          const roots = createFakeWorkspaceRoots({
            workspacePath: '/workspace',
          });
          /** One desktop window following the session's tool edits. */
          const openWindow = (focused: boolean) =>
            Effect.gen(function* () {
              const opened: string[] = [];
              // The previews the host staged, as each program produces one.
              const staged: ToolEditPreview[] = [];
              const host = new desktopModule.DesktopToolEditApprovalHost({
                spawn: (program) => {
                  testRuntime().runFork(program);
                },
                focused: () => focused,
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
              const stageOnHost = host.stagePreview.bind(host);
              vi.spyOn(host, 'stagePreview').mockImplementation((request) =>
                stageOnHost(request).pipe(
                  Effect.tap((preview) =>
                    Effect.sync(() => staged.push(preview)),
                  ),
                ),
              );
              const controller =
                new controllerModule.ToolEditApprovalController({
                  host,
                  session: testSessionOf(session),
                  roots,
                });
              const window = testRuntime().runFork(controller.follow);
              yield* Effect.addFinalizer(() => Fiber.interrupt(window));
              return { controller, opened, staged, window };
            });
          const closing = yield* openWindow(true);
          const approving = yield* openWindow(false);

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
                  roots,
                  workingDirectory: '/workspace',
                  run: { runId, session, toolPolicy: {} },
                }),
              ),
            ),
          );
          // Listed by the fold and staged in both windows.
          yield* Effect.tryPromise(() =>
            vi.waitFor(() => {
              expect(closing.staged).toHaveLength(1);
              expect(approving.staged).toHaveLength(1);
            }, 10_000),
          );
          const { requestId } = SubscriptionRef.getUnsafe(session.view.ref)
            .requests[0]!;

          // The user edits the proposed copy in the first window, which then
          // closes with the request still pending (#14009).
          yield* onRuntime(
            closing.controller.handleAction({
              requestId,
              action: 'previewProposed',
            }),
          );
          yield* Effect.tryPromise(() =>
            vi.waitFor(() => expect(closing.opened).toHaveLength(1)),
          );
          const edited = 'beta\nwith user edits\nand more\n';
          yield* Effect.tryPromise(() =>
            writeFile(closing.opened[0]!, edited, 'utf8'),
          );
          yield* Fiber.interrupt(closing.window);
          expect(
            yield* Effect.promise(() => pathExists(closing.opened[0]!)),
          ).toBe(false);

          // The other window's Approve applies that edit.
          yield* onRuntime(
            approving.controller.handleAction({ requestId, action: 'approve' }),
          );
          expect(yield* Fiber.join(result)).toMatchObject({
            action: 'apply',
            appliedContent: edited,
            lineChanges: { added: 3, removed: 1 },
          });
          yield* Effect.tryPromise(() =>
            vi.waitFor(async () => {
              await expect(
                pathExists(approving.staged[0]!.proposedPath),
              ).resolves.toBe(false);
            }),
          );
        }),
      ),
    30_000,
  );
});
