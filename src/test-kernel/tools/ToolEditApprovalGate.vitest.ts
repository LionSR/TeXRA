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

import {
  generateRunId,
  type RequestDecision,
  type RunId,
} from '@texra-ai/harness/schemas';
import { requestToolEditApproval } from '@texra-ai/harness/plugins';
import { WorkspaceFs } from '@texra-ai/harness/host';
import type { ToolServices } from '@agent/runtime/ToolServices';
import { humanGrant } from '@agent/runtime/runApprovalQueue';
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
// The tool edits the run opened, as their rows reached the log; tests
// override the decision when they need to reject or adjust, and assert on
// this list otherwise.
const openedEdits = () =>
  decisions?.opened.filter((event) => event.payload.kind === 'toolEdit') ?? [];

async function installPlatform(
  config: Record<string, unknown> = {},
  files: Record<string, string | Uint8Array> = {},
) {
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
      mkdirSync(WORKSPACE_PATH, { recursive: true });
      // A dangling symlink names a workspace entry even though stat through
      // the link fails; the read-before-edit gate must not treat it as new.
      symlinkSync(
        path.join(WORKSPACE_PATH, 'gone.txt'),
        path.join(WORKSPACE_PATH, 'dangling.txt'),
      );

      const result = yield* inRun(
        EditFileTool.call({ path: 'dangling.txt', old_str: 'a', new_str: 'b' }),
      );

      assert.strictEqual(result.status, 'error');
      assert.match(result.error ?? '', /require a prior read/);
      assert.strictEqual(workspaceWrites.mock.calls.length, 0);
      assert.strictEqual(openedEdits().length, 0);
    }),
  );

  it.effect('write_file rejects when user denies approval', () =>
    Effect.gen(function* () {
      const write = stubWorkspaceFile('summary.txt', {
        exists: true,
        content: 'base',
      });

      nextDecision = () => ({ action: 'reject', feedback: 'Rejected by user' });

      const result = yield* inRun(
        writeFileTool().call({ path: 'summary.txt', content: 'new content' }),
      );

      assert.strictEqual(write.mock.calls.length, 0);
      assert.strictEqual(result.status, 'error');
      assert.strictEqual(result.userInstruction, 'Rejected by user');
    }),
  );

  it.effect('lets never override a disabled approval setting', () =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        installPlatform({ 'toolUse.requireEditApproval': false }),
      );
      setTestApprovalPolicy('never', testDefaultSession().roots);

      const write = stubWorkspaceFile('denied.txt', {
        exists: false,
        content: '',
      });

      const result = yield* inRun(
        writeFileTool().call({ path: 'denied.txt', content: 'blocked' }),
      );

      assert.strictEqual(openedEdits().length, 0);
      assert.strictEqual(write.mock.calls.length, 0);
      assert.strictEqual(result.status, 'error');
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
        waitForCondition(() => openedEdits().length === 1, {
          timeoutMessage: 'Timed out waiting for the first edit to be opened',
        }),
      );

      yield* testDefaultSession().approvals.change(
        runId,
        humanGrant(['toolEdit'], true),
      );
      decideRequest(
        testDefaultSession(),
        { runId, requestId: openedEdits()[0]!.requestId },
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
      assert.strictEqual(openedEdits().length, 1);
    }),
  );

  it.live(
    "stores a pending edit's proposal with its request, where any process reads it",
    () =>
      Effect.gen(function* () {
        // Left pending: the proposal must be readable while nothing but the
        // rows holds it, as it is after the process that opened it is gone.
        nextDecision = () => null;
        const request = yield* Effect.forkChild(
          inRun(
            requestToolEditApproval({
              path: 'draft.txt',
              originalContent: 'alpha\n',
              proposedContent: 'beta\n',
              sourceTool: 'write_file',
            }),
          ),
        );
        yield* Effect.tryPromise(() =>
          waitForCondition(() => openedEdits().length === 1, {
            timeoutMessage: 'Timed out waiting for the edit to be opened',
          }),
        );
        const opened = openedEdits()[0]!;
        const address =
          opened.payload.kind === 'toolEdit'
            ? opened.payload.data.content
            : undefined;
        assert.ok(address, 'the request names its proposal by address');
        const session = testDefaultSession();
        const stored = (yield* session.log.blobs([address])).get(address);
        assert.ok(stored, 'the store holds the proposal under that address');
        const content: unknown = JSON.parse(stored);
        assert.ok(typeof content === 'object' && content !== null);
        assert.strictEqual(
          (content as { originalContent?: unknown }).originalContent,
          'alpha\n',
        );
        assert.strictEqual(
          (content as { proposedContent?: unknown }).proposedContent,
          'beta\n',
        );
        // The door a surface reads the diff through answers from the store.
        const { preview } = yield* session.requests.request({
          kind: 'request.preview',
          runId,
          requestId: opened.requestId,
        });
        assert.deepStrictEqual(preview, content);
        decideRequest(
          session,
          { runId, requestId: opened.requestId },
          { action: 'reject' },
        );
        assert.strictEqual((yield* Fiber.join(request)).action, 'reject');
      }),
  );
});
