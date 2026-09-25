// Test composition imports

// Node imports
import * as assert from 'node:assert';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber, FileSystem } from 'effect';
import { describe, beforeEach, afterEach, vi } from 'vitest';

// Local imports
import type { ToolServices } from '@agent/runtime/ToolServices';
import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';

import { WorkspaceFs } from '@platform/rootedFs';
import type { RequestDecision, RunId } from '@shared/schemas';
import { DatabaseWriteFailed } from '@shared/session/database';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { waitForCondition } from '@test/support/asyncTestUtils';
import { fakePath } from '@test/support/FakePlatform';
import {
  createFakeHost,
  installPlatform as installFakePlatform,
} from '@test/support/setupPlatform';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { EditFileTool } from '@tools/EditTool';
import { WriteFileTool } from '@tools/WriteTool';
import {
  requestToolEditApproval,
  type ToolEditApprovalRequest,
} from '@tools/approval/toolEditApproval';
import { generateRunId } from '@utils/core';

// Local file imports
import { autoDecideRequests, decideRequest } from '../agent/progressTestUtils';

// A real directory: the edit flow reads the current content through the
// process filesystem, so the file a case stubs has to exist where the
// workspace says it does.
const WORKSPACE_PATH = fakePath('workspace');

// A tool edit opens its request on a run, so every case owns a freshly
// started one; the file's default session outlives the individual tests.
let runId: RunId;

// The decision a surface sends for each request the run opens; a case that
// must park one returns null and decides it later with `decideRequest`.
let nextDecision: () => RequestDecision | null = () => ({ action: 'approve' });
let decisions: ReturnType<typeof autoDecideRequests> | undefined;
let detachHostInteractions = (): void => {};
let policyDenials = 0;
let tracker = new FileInteractionState();
// The previews the host staged; tests override the decision when they need to
// reject or adjust, and assert on this list otherwise.
let approvalRequests: ToolEditApprovalRequest[] = [];
// The previews the runtime released without a decision, by request id.
let releasedPreviews: string[] = [];

async function installPlatform(
  config: Record<string, unknown> = {},
  files: Record<string, string | Uint8Array> = {},
) {
  approvalRequests = [];
  releasedPreviews = [];
  nextDecision = () => ({ action: 'approve' });
  await installFakePlatform({
    workspacePath: WORKSPACE_PATH,
    config,
    files,
  });
  detachHostInteractions();
  detachHostInteractions = Effect.runSync(
    testDefaultSession().interactions.use({
      presentToolEdit: (request) => {
        approvalRequests.push(request);
      },
      releaseToolEdit: (requestId) =>
        Effect.sync(() => {
          releasedPreviews.push(requestId);
        }),
    }),
  );
}

// The write side of both views the edit flow reaches: an absolute path writes
// through the process `FileSystem`, a workspace-relative one through the
// session's rooted `WorkspaceFs` view. One
// recorder serves both, so a case asserts on what was applied either way.
const workspaceWrites = vi.fn<(target: string, content: string) => void>();
// The workspace-relative half of the read side, which no real directory backs.
const relativeFiles = new Map<string, { exists: boolean; content: string }>();

/** Install the stubbed halves over the real services for one tool call. */
function withStubbedEditFiles<A, E, R>(program: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const workspaceFs = yield* WorkspaceFs;
    const processFs = yield* FileSystem.FileSystem;
    return yield* program.pipe(
      Effect.provideService(WorkspaceFs, {
        ...workspaceFs,
        exists: (target: string) =>
          Effect.succeed(relativeFiles.get(target)?.exists ?? false),
        readFile: (target: string) =>
          Effect.succeed(
            Buffer.from(relativeFiles.get(target)?.content ?? '', 'utf-8'),
          ),
        writeFile: (target: string, content: Uint8Array) => {
          workspaceWrites(target, Buffer.from(content).toString('utf-8'));
          return Effect.void;
        },
      }),
      Effect.provideService(FileSystem.FileSystem, {
        ...processFs,
        writeFile: (target: string, content: Uint8Array) => {
          workspaceWrites(target, Buffer.from(content).toString('utf-8'));
          return Effect.void;
        },
      }),
    );
  });
}

// Seeds the file a tool reads before proposing an edit — on disk for the
// edit flow's own read, and in the rooted view a relative path resolves
// through — and returns the write spy so a test can inspect what was applied.
function stubWorkspaceFile(
  filePath: string,
  options: { exists: boolean; content: string },
) {
  const absolutePath = path.join(WORKSPACE_PATH, filePath);
  if (options.exists) {
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, options.content);
    tracker.recordRead(absolutePath);
  }
  relativeFiles.set(filePath, {
    exists: options.exists,
    content: options.content,
  });
  return workspaceWrites;
}

/** Supply the exact per-call capabilities a dispatched tool receives. */
function inRun<A, E>(effect: Effect.Effect<A, E, ToolServices>) {
  return withStubbedEditFiles(effect).pipe(
    Effect.provide(
      nativeToolTestLayer({
        workingDirectory: WORKSPACE_PATH,
        tracker,
        run: {
          runId,
          session: testDefaultSession(),
          toolPolicy: {},
          onApprovalPolicyDenial: () => {
            policyDenials += 1;
          },
        },
      }),
    ),
  );
}

describe('Tool edit approval gating', () => {
  beforeEach(async () => {
    await installPlatform();
    testDefaultSession().setApprovalPolicy('ask');
    policyDenials = 0;
    workspaceWrites.mockReset();
    relativeFiles.clear();
    tracker = new FileInteractionState();
    testDefaultSession().approvals.clearAll();
    runId = publishTestRunStart(testDefaultSession(), generateRunId());
    await Effect.runPromise(testDefaultSession().settlePublications());
    decisions = autoDecideRequests(testDefaultSession(), () => nextDecision());
  });

  afterEach(() => {
    decisions?.detach();
    decisions = undefined;
    vi.restoreAllMocks();
    detachHostInteractions();
    detachHostInteractions = () => {};
    testDefaultSession().approvals.clearAll();
  });

  it.effect('gates an edit to a dangling symlink as an existing file', () =>
    Effect.gen(function* () {
      const tool = EditFileTool;
      mkdirSync(WORKSPACE_PATH, { recursive: true });
      // A dangling symlink names a workspace entry even though stat through
      // the link fails; the read-before-edit gate must not treat it as new.
      symlinkSync(
        path.join(WORKSPACE_PATH, 'gone.txt'),
        path.join(WORKSPACE_PATH, 'dangling.txt'),
      );
      const write = workspaceWrites;

      const result = yield* inRun(
        tool.call({ path: 'dangling.txt', old_str: 'a', new_str: 'b' }),
      );

      assert.strictEqual(result.status, 'error');
      assert.match(result.error ?? '', /require a prior read/);
      assert.strictEqual(write.mock.calls.length, 0);
      assert.strictEqual(approvalRequests.length, 0);
    }),
  );

  it.effect('write_file applies changes after approval', () =>
    Effect.gen(function* () {
      const tool = WriteFileTool;
      const write = stubWorkspaceFile('doc.txt', {
        exists: true,
        content: 'old content',
      });

      const result = yield* inRun(
        tool.call({ path: 'doc.txt', content: 'new content' }),
      );

      const [request] = approvalRequests;
      assert.strictEqual(request?.path, path.join(WORKSPACE_PATH, 'doc.txt'));
      assert.strictEqual(request?.permission.relativePath, 'doc.txt');
      assert.strictEqual(request?.originalContent, 'old content');
      assert.strictEqual(request?.proposedContent, 'new content');
      assert.strictEqual(request?.sourceTool, 'write_file');
      assert.strictEqual(write.mock.lastCall?.[1], 'new content');
      assert.strictEqual(
        result.output,
        'written\n\nReplaced 1 lines with 1 lines.',
      );
      assert.strictEqual(result.userInstruction, undefined);
    }),
  );

  it.effect('write_file resolves paths in the invoking project scope', () =>
    Effect.gen(function* () {
      const tool = WriteFileTool;
      const project = createFakeHost({
        workspacePath: path.resolve(path.sep, 'project'),
        config: { 'texra.toolUse.requireEditApproval': true },
      });
      const projectPath = project.roots.workspace!;
      const filePath = path.join(projectPath, 'scoped.txt');
      tracker.recordRead('scoped.txt');
      relativeFiles.set('scoped.txt', { exists: true, content: 'old content' });
      const write = workspaceWrites;

      const result = yield* withStubbedEditFiles(
        tool.call({ path: filePath, content: 'new content' }),
      ).pipe(
        Effect.provide(
          nativeToolTestLayer({
            tracker,
            run: { runId, session: testDefaultSession(), toolPolicy: {} },
            roots: project.roots,
          }),
        ),
      );

      assert.strictEqual(result.status, 'executed');
      assert.strictEqual(approvalRequests[0]?.path, 'scoped.txt');
      assert.strictEqual(write.mock.lastCall?.[0], 'scoped.txt');
    }),
  );

  it.effect('write_file reports the content adjusted during approval', () =>
    Effect.gen(function* () {
      const tool = WriteFileTool;
      const write = stubWorkspaceFile('doc.txt', {
        exists: true,
        content: 'old content',
      });
      nextDecision = () => ({ action: 'approve', content: 'reviewed content' });

      const result = yield* inRun(
        tool.call({ path: 'doc.txt', content: 'new content' }),
      );

      assert.strictEqual(write.mock.lastCall?.[1], 'reviewed content');
      assert.match(result.output ?? '', /User adjustments to doc\.txt/);
      assert.strictEqual(result.edits?.[0]?.path, 'doc.txt');
      assert.strictEqual(result.edits?.[0]?.startLine, 1);
    }),
  );

  it.effect('write_file rejects when user denies approval', () =>
    Effect.gen(function* () {
      const tool = WriteFileTool;
      const write = stubWorkspaceFile('summary.txt', {
        exists: true,
        content: 'base',
      });

      nextDecision = () => ({ action: 'reject', feedback: 'Rejected by user' });

      const result = yield* inRun(
        tool.call({ path: 'summary.txt', content: 'new content' }),
      );

      assert.strictEqual(write.mock.calls.length, 0);
      assert.strictEqual(result.status, 'error');
      assert.strictEqual(
        result.error,
        'User rejected write_file for summary.txt.',
      );
      assert.strictEqual(result.userInstruction, 'Rejected by user');
    }),
  );

  it.effect('does not present an automatic cancellation as user feedback', () =>
    Effect.gen(function* () {
      const tool = WriteFileTool;
      const write = stubWorkspaceFile('summary.txt', {
        exists: true,
        content: 'base',
      });
      nextDecision = () => ({ action: 'cancel', cause: 'Session disposed.' });

      const result = yield* inRun(
        tool.call({ path: 'summary.txt', content: 'new content' }),
      );

      assert.strictEqual(write.mock.calls.length, 0);
      assert.match(result.error ?? '', /Tool edit cancelled/);
      assert.match(result.error ?? '', /Session disposed\./);
      assert.strictEqual(result.userInstruction, undefined);
    }),
  );

  it.effect('write_file skips approval when disabled via config', () =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        installPlatform({ 'texra.toolUse.requireEditApproval': false }),
      );
      const tool = WriteFileTool;
      const write = stubWorkspaceFile('doc.txt', {
        exists: false,
        content: '',
      });

      const result = yield* inRun(
        tool.call({ path: 'doc.txt', content: 'new content' }),
      );

      assert.strictEqual(approvalRequests.length, 0);
      assert.strictEqual(write.mock.lastCall?.[1], 'new content');
      assert.strictEqual(result.output, 'written');
    }),
  );

  it.effect('lets never override a disabled approval setting', () =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        installPlatform({ 'texra.toolUse.requireEditApproval': false }),
      );
      testDefaultSession().setApprovalPolicy('never');

      const tool = WriteFileTool;
      const write = stubWorkspaceFile('denied.txt', {
        exists: false,
        content: '',
      });

      const result = yield* inRun(
        tool.call({ path: 'denied.txt', content: 'blocked' }),
      );

      assert.strictEqual(approvalRequests.length, 0);
      assert.strictEqual(write.mock.calls.length, 0);
      assert.strictEqual(result.status, 'error');
      assert.strictEqual(result.userInstruction, undefined);
      assert.match(result.error ?? '', /Denied by TeXRA approval policy\./);
      assert.strictEqual(policyDenials, 1);
    }),
  );

  it.effect('session bypass auto-approves pending requests', () =>
    Effect.gen(function* () {
      const tool = WriteFileTool;
      const write = stubWorkspaceFile('doc.txt', {
        exists: false,
        content: '',
      });

      testDefaultSession().approvals.toolEdit.bypass.setBypass(runId, true, {
        silent: true,
      });

      // The bypass check requires a runId on the request; the approval layer
      // picks it up from the active run context.
      const result = yield* inRun(
        tool.call({ path: 'doc.txt', content: 'auto' }),
      );

      assert.strictEqual(approvalRequests.length, 0);
      assert.strictEqual(write.mock.lastCall?.[1], 'auto');
      assert.strictEqual(result.output, 'written');
    }),
  );

  it.effect('releases the staged preview when its request cannot open', () =>
    Effect.gen(function* () {
      // The commit that would list the request is refused, so no
      // `request.decided` will ever release the preview staged before it:
      // `openRequest`, the one call that knows the row never landed, runs
      // the release the staging handed it.
      const session = testDefaultSession();
      const commit = session.commit.bind(session);
      vi.spyOn(session, 'commit').mockImplementation((events) =>
        events.some((event) => event.type === 'request.opened')
          ? Effect.fail(
              new DatabaseWriteFailed({
                path: 'session.db',
                cause: 'the disk is full',
              }),
            )
          : commit(events),
      );

      const failure = yield* inRun(
        requestToolEditApproval({
          path: 'doc.txt',
          originalContent: 'old content',
          proposedContent: 'new content',
          sourceTool: 'write_file',
        }),
      ).pipe(Effect.flip);

      assert.ok(failure instanceof DatabaseWriteFailed);
      assert.deepStrictEqual(releasedPreviews, [
        approvalRequests[0]?.permission.requestId,
      ]);
    }),
  );

  it.live(
    'releases the staged preview when the open is interrupted mid-commit',
    () =>
      Effect.gen(function* () {
        // The `request.opened` commit never settles, so the interrupt lands
        // with no row written: the cancellation finds nothing open, writes
        // no decision, and releases what the open never listed.
        const session = testDefaultSession();
        const commit = session.commit.bind(session);
        vi.spyOn(session, 'commit').mockImplementation((events) =>
          events.some((event) => event.type === 'request.opened')
            ? Effect.never
            : commit(events),
        );

        const request = yield* Effect.forkChild(
          inRun(
            requestToolEditApproval({
              path: 'doc.txt',
              originalContent: 'old content',
              proposedContent: 'new content',
              sourceTool: 'write_file',
            }),
          ),
        );
        yield* Effect.tryPromise(() =>
          waitForCondition(() => approvalRequests.length === 1, {
            timeoutMessage: 'Timed out waiting for the edit to be staged',
          }),
        );

        yield* Fiber.interrupt(request);

        // The cancellation is a job of the session's publisher, so the
        // release it finds necessary lands with it, not with the interrupt.
        yield* Effect.tryPromise(() =>
          waitForCondition(() => releasedPreviews.length === 1, {
            timeoutMessage: 'Timed out waiting for the preview to be released',
          }),
        );
        assert.deepStrictEqual(releasedPreviews, [
          approvalRequests[0]?.permission.requestId,
        ]);
      }),
  );

  it.live(
    'leaves a committed request its decision when the open is interrupted',
    () =>
      Effect.gen(function* () {
        // The row landed, so the interrupt's cancellation is a decision like
        // any other and every host releases on that. Releasing here too
        // would strand the request the fold still lists whenever that
        // cancellation is itself refused: nothing left to render, nothing
        // left to answer.
        nextDecision = () => null;
        const session = testDefaultSession();

        const request = yield* Effect.forkChild(
          inRun(
            requestToolEditApproval({
              path: 'doc.txt',
              originalContent: 'old content',
              proposedContent: 'new content',
              sourceTool: 'write_file',
            }),
          ),
        );
        yield* Effect.tryPromise(() =>
          waitForCondition(() => decisions?.opened.length === 1, {
            timeoutMessage: 'Timed out waiting for the request to open',
          }),
        );

        yield* Fiber.interrupt(request);
        yield* session.settlePublications();

        assert.deepStrictEqual(releasedPreviews, []);
      }),
  );

  it.live('rechecks session bypass between concurrent approval requests', () =>
    Effect.gen(function* () {
      // The first request stays parked so the second is enqueued behind it.
      nextDecision = () => null;

      const requestInRun = (path: string) =>
        inRun(
          requestToolEditApproval({
            path,
            originalContent: '',
            proposedContent: path,
            sourceTool: 'write_file',
          }),
        );

      const firstRequest = yield* Effect.forkChild(requestInRun('first.txt'));
      const secondRequest = yield* Effect.forkChild(requestInRun('second.txt'));
      yield* Effect.tryPromise(() =>
        waitForCondition(() => approvalRequests.length === 1, {
          timeoutMessage: 'Timed out waiting for the first edit to be staged',
        }),
      );

      testDefaultSession().approvals.toolEdit.bypass.setBypass(runId, true, {
        silent: true,
      });
      decideRequest(
        testDefaultSession(),
        { runId, requestId: approvalRequests[0]!.permission.requestId },
        { action: 'approve', content: 'first.txt' },
      );

      const results = yield* Effect.all([
        Fiber.join(firstRequest),
        Fiber.join(secondRequest),
      ]);
      assert.deepStrictEqual(
        results.map((result) => result.action),
        ['apply', 'apply'],
      );
      // The bypassed second request never reaches a surface.
      assert.strictEqual(approvalRequests.length, 1);
    }),
  );
});
