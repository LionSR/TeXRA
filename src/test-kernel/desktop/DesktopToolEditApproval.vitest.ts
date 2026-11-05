import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { layer } from '@effect/vitest';
import {
  Effect,
  Fiber,
  type FileSystem,
  type Path,
  SubscriptionRef,
  Context,
  Schema,
} from 'effect';
import { afterEach, expect, vi } from 'vitest';

import { RunIdSchema } from '@texra-ai/harness/schemas';
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
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * A session, the desktop windows that follow its tool edits, and the one
 * edit a write_file call asks it for: `beta` in place of `alpha`.
 */
const review = Effect.gen(function* () {
  // The window's process runtime. The controller's verbs are Effects and it
  // holds no runtime of its own; a desktop window hands them its process
  // runtime, and so does this suite.
  const runtime = yield* SessionGraph.runtime;
  const onRuntime = <A, E>(
    program: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner
    >,
  ) => Effect.promise(() => runtime.runPromise(program));
  const localSession = yield* TestSession.open(undefined, { host: {} });
  const session = yield* sessionHandleOf(localSession);
  const roots = createFakeWorkspaceRoots({ workspacePath: '/workspace' });
  /** One desktop window following the session's tool edits. */
  const openWindow = (focused: boolean) =>
    Effect.gen(function* () {
      const opened: string[] = [];
      const warnings: string[] = [];
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
          showWarningMessage: (message) =>
            Effect.sync(() => {
              warnings.push(message);
            }),
          closeDiff: () => Effect.void,
        },
      });
      const stageOnHost = host.stagePreview.bind(host);
      vi.spyOn(host, 'stagePreview').mockImplementation((request) =>
        stageOnHost(request).pipe(
          Effect.tap((preview) => Effect.sync(() => staged.push(preview))),
        ),
      );
      const controller = new ToolEditApprovalController({
        host,
        session: localSession,
        roots,
      });
      const window = runtime.runFork(controller.follow);
      yield* Effect.addFinalizer(() => Fiber.interrupt(window));
      return { controller, opened, staged, warnings };
    });
  /** Ask for the edit; the fiber ends with its answer. */
  const requestEdit = Effect.gen(function* () {
    // A request row is only ever appended to a run the history knows.
    const runId = Schema.decodeSync(RunIdSchema)('a40000');
    publishTestRunStart(session, runId);
    yield* Context.get(session, SessionLog).settled;
    return yield* Effect.forkScoped(
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
  });
  const pendingRequestId = () =>
    SubscriptionRef.getUnsafe(Context.get(session, SessionViewAccess).ref)
      .requests[0].requestId;
  return { onRuntime, openWindow, requestEdit, pendingRequestId };
});

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
          const { onRuntime, openWindow, requestEdit, pendingRequestId } =
            yield* review;
          const window = yield* openWindow(true);
          const result = yield* requestEdit;
          // Listed by the fold and staged from the request's own content.
          yield* Effect.tryPromise(() =>
            vi.waitFor(() => expect(window.staged).toHaveLength(1), 10_000),
          );
          const requestId = pendingRequestId();

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
            writeFile(window.opened[0], edited, 'utf8'),
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
                pathExists(window.staged[0].proposedPath),
              ).resolves.toBe(false);
            }),
          );
        }),
      30_000,
    );

    // Two windows edit one request. What can go wrong with a window's
    // proposed copy when its request ends, each checked below:
    //  1. another window answers while the copy holds edits, and they go
    //     with the preview without a word;
    //  2. a copy nobody changed is kept, or reported;
    //  3. a window's own recorded approval is reported as not applied;
    //  4. a stale copy replaces the answer another window recorded;
    //  5. an unchanged approval applies anything but the proposal.
    it.effect(
      'keeps the edits of a window whose request another window answers',
      () =>
        Effect.gen(function* () {
          const { onRuntime, openWindow, requestEdit, pendingRequestId } =
            yield* review;
          const answering = yield* openWindow(true);
          const editing = yield* openWindow(false);
          const result = yield* requestEdit;
          yield* Effect.tryPromise(() =>
            vi.waitFor(() => {
              expect(answering.staged).toHaveLength(1);
              expect(editing.staged).toHaveLength(1);
            }, 10_000),
          );
          const requestId = pendingRequestId();

          // The user edits the proposed copy in one window, on disk as the
          // editor the desktop opens it in saves it...
          yield* onRuntime(
            editing.controller.handleAction({
              requestId,
              action: 'previewProposed',
            }),
          );
          yield* Effect.tryPromise(() =>
            vi.waitFor(() => expect(editing.opened).toHaveLength(1)),
          );
          const copy = editing.opened[0];
          yield* Effect.addFinalizer(() =>
            Effect.promise(() =>
              rm(dirname(copy), { recursive: true, force: true }),
            ),
          );
          const edited = 'beta\nedited in the other window\n';
          yield* Effect.tryPromise(() => writeFile(copy, edited, 'utf8'));

          // ...and approves the untouched proposal in the other.
          yield* onRuntime(
            answering.controller.handleAction({ requestId, action: 'approve' }),
          );
          expect(yield* Fiber.join(result)).toMatchObject({
            action: 'apply',
            appliedContent: 'beta\n',
          });

          // The editing window's changes were not applied: it keeps them
          // where its editor has them, and says so once.
          yield* Effect.tryPromise(() =>
            vi.waitFor(() => expect(editing.warnings).toHaveLength(1)),
          );
          expect(editing.warnings[0]).toContain('notes.txt');
          expect(editing.warnings[0]).toContain(copy);
          expect(yield* Effect.promise(() => readFile(copy, 'utf8'))).toBe(
            edited,
          );
          // The answering window sent its copy: nothing to keep or say.
          yield* Effect.tryPromise(() =>
            vi.waitFor(async () => {
              await expect(
                pathExists(answering.staged[0].proposedPath),
              ).resolves.toBe(false);
            }),
          );
          expect(answering.warnings).toStrictEqual([]);
        }),
      30_000,
    );
  },
);
