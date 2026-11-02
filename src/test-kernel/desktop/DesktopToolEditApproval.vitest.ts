import { access, writeFile } from 'node:fs/promises';

import { layer } from '@effect/vitest';
import {
  Effect,
  Fiber,
  type FileSystem,
  type Path,
  SubscriptionRef,
  Context,
} from 'effect';
import { afterEach, expect, vi } from 'vitest';

import { DesktopToolEditApprovalHost } from '@desktop/main/desktopToolEditApproval';
import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import {
  ToolEditApprovalController,
  type ToolEditPreview,
} from '@texra/controllers/approval/ToolEditApprovalController';
import { requestToolEditApproval } from '@tools/approval/toolEditApproval';
import type { RunId } from '@texra-ai/harness/schemas';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Live clock: the window follows the session's log, and the user acts on
// it, on real turns.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'desktop tool edit approval',
  (it) => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.effect(
      'applies the proposed copy as the user left it when the window approves',
      () =>
        Effect.gen(function* () {
          // The window's process runtime. The controller's verbs are Effects
          // and it holds no runtime of its own; a desktop window hands them
          // its process runtime, and so does this suite.
          const runtime = yield* SessionGraph.runtime;
          const onRuntime = <A, E>(
            program: Effect.Effect<
              A,
              E,
              FileSystem.FileSystem | Path.Path | ChildProcessSpawner
            >,
          ) => Effect.promise(() => runtime.runPromise(program));
          const localSession = yield* TestSession.open(undefined, {
            host: {},
          });
          const session = yield* sessionHandleOf(localSession);
          const roots = createFakeWorkspaceRoots({
            workspacePath: '/workspace',
          });
          /** One desktop window following the session's tool edits. */
          const openWindow = (focused: boolean) =>
            Effect.gen(function* () {
              const opened: string[] = [];
              // The previews the host staged, as each program produces one.
              const staged: ToolEditPreview[] = [];
              const host = new DesktopToolEditApprovalHost({
                spawn: (program) => {
                  runtime.runFork(program);
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
              const controller = new ToolEditApprovalController({
                host,
                session: localSession,
                roots,
              });
              const window = runtime.runFork(controller.follow);
              yield* Effect.addFinalizer(() => Fiber.interrupt(window));
              return { controller, opened, staged, window };
            });
          const window = yield* openWindow(true);

          // A request row is only ever appended to a run the history knows.
          const runId = 'a40000' as RunId;
          publishTestRunStart(session, runId);
          yield* Context.get(session, SessionLog).settled;
          const result = yield* Effect.forkScoped(
            requestToolEditApproval({
              path: '/workspace/notes.txt',
              originalContent: 'alpha\n',
              proposedContent: 'beta\n',
              sourceTool: 'write_file',
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
          // Listed by the fold and staged from the request's own content.
          yield* Effect.tryPromise(() =>
            vi.waitFor(() => expect(window.staged).toHaveLength(1), 10_000),
          );
          const { requestId } = SubscriptionRef.getUnsafe(
            Context.get(session, SessionViewAccess).ref,
          ).requests[0]!;

          // The user opens the proposed copy and edits it on disk.
          yield* onRuntime(
            window.controller.handleAction({
              requestId,
              action: 'previewProposed',
            }),
          );
          yield* Effect.tryPromise(() =>
            vi.waitFor(() => expect(window.opened).toHaveLength(1)),
          );
          const edited = 'beta\nwith user edits\nand more\n';
          yield* Effect.tryPromise(() =>
            writeFile(window.opened[0]!, edited, 'utf8'),
          );

          // Approve sends the copy as the user left it with the decision,
          // which applies it.
          yield* onRuntime(
            window.controller.handleAction({ requestId, action: 'approve' }),
          );
          expect(yield* Fiber.join(result)).toMatchObject({
            action: 'apply',
            appliedContent: edited,
            lineChanges: { added: 3, removed: 1 },
          });
          yield* Effect.tryPromise(() =>
            vi.waitFor(async () => {
              await expect(
                pathExists(window.staged[0]!.proposedPath),
              ).resolves.toBe(false);
            }),
          );
        }),
      30_000,
    );
  },
);
