// Test composition imports

// Node imports
import * as assert from 'node:assert';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber, FileSystem } from 'effect';
import { describe, beforeEach, afterEach, vi } from 'vitest';
import { humanGrant } from '@agent/runtime/runApprovalQueue';

// Local imports
import type { ToolServices } from '@agent/runtime/ToolServices';

import { WorkspaceFs } from '@platform/rootedFs';
import type { RequestDecision, RunId } from '@shared/schemas';
import {
  setTestApprovalPolicy,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { waitForCondition } from '@test/support/asyncTestUtils';
import { fakePath } from '@test/support/FakePlatform';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { EditFileTool } from '@tools/EditTool';
import { writeFileTool } from '@tools/WriteTool';
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
let readFiles = new Set<string>();
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
      approvalDenied: () => {
        policyDenials += 1;
      },
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
        makeDirectory: () => Effect.void,
      }),
      Effect.provideService(FileSystem.FileSystem, {
        ...processFs,
        writeFile: (target: string, content: Uint8Array) => {
          workspaceWrites(target, Buffer.from(content).toString('utf-8'));
          return Effect.void;
        },
        makeDirectory: () => Effect.void,
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
    readFiles.add(absolutePath);
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
        readFiles,
        run: {
          runId,
          session: testDefaultSession(),
          toolPolicy: {},
        },
      }),
    ),
  );
}

describe('Tool edit approval gating', () => {
  beforeEach(async () => {
    await installPlatform();
    setTestApprovalPolicy('ask', testDefaultSession().roots);
    policyDenials = 0;
    workspaceWrites.mockReset();
    relativeFiles.clear();
    readFiles = new Set<string>();
    runId = publishTestRunStart(testDefaultSession(), generateRunId());
    await Effect.runPromise(testDefaultSession().log.settled);
    decisions = autoDecideRequests(testDefaultSession(), () => nextDecision());
  });

  afterEach(() => {
    decisions?.detach();
    decisions = undefined;
    vi.restoreAllMocks();
    detachHostInteractions();
    detachHostInteractions = () => {};
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

  it.effect('write_file rejects when user denies approval', () =>
    Effect.gen(function* () {
      const tool = writeFileTool();
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

  it.effect('lets never override a disabled approval setting', () =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        installPlatform({ 'texra.toolUse.requireEditApproval': false }),
      );
      setTestApprovalPolicy('never', testDefaultSession().roots);

      const tool = writeFileTool();
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
      assert.match(result.error ?? '', /Denied by the approval policy\./);
      assert.strictEqual(policyDenials, 1);
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

      yield* testDefaultSession().approvals.change(
        runId,
        humanGrant(['toolEdit'], true),
      );
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
