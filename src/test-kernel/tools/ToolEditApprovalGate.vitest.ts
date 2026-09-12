// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Node imports
import * as assert from 'node:assert';
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { describe, beforeEach, afterEach, vi } from 'vitest';

// Local imports
import type { ToolServices } from '@agent/runtime/ToolServices';
import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { runWithWorkspaceRoots } from '@platform/workspaceRoots';
import type { RequestDecision, RunId } from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { waitForCondition } from '@test/support/asyncTestUtils';
import {
  createFakeHost,
  installPlatform as installFakePlatform,
} from '@test/support/setupPlatform';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { WriteFileTool } from '@tools/WriteTool';
import {
  requestToolEditApproval,
  type ToolEditApprovalRequest,
} from '@tools/approval/toolEditApproval';
import { generateRunId } from '@utils/core';
import { WorkspaceFS } from '@utils/files/workspaceFS';

// Local file imports
import { autoDecideRequests, decideRequest } from '../agent/progressTestUtils';

const WORKSPACE_PATH = path.resolve(path.sep, 'workspace');

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

async function installPlatform(
  config: Record<string, unknown> = {},
  files: Record<string, string | Uint8Array> = {},
) {
  approvalRequests = [];
  nextDecision = () => ({ action: 'approve' });
  await installFakePlatform({
    workspacePath: WORKSPACE_PATH,
    config,
    files,
  });
  detachHostInteractions();
  detachHostInteractions = defaultSession().interactions.use({
    presentToolEdit: (request) => {
      approvalRequests.push(request);
    },
  });
}

// Spies the workspace reads a tool performs before proposing an edit and
// returns the write spy so a test can inspect what was applied.
function stubWorkspaceFile(
  filePath: string,
  options: { exists: boolean; content: string },
) {
  if (options.exists) tracker.recordRead(path.join(WORKSPACE_PATH, filePath));
  vi.spyOn(WorkspaceFS, 'exists').mockResolvedValue(options.exists);
  vi.spyOn(WorkspaceFS, 'read').mockResolvedValue(options.content);
  return vi.spyOn(WorkspaceFS, 'write').mockResolvedValue(undefined);
}

/** Supply the exact per-call capabilities a dispatched tool receives. */
function inRun<A, E>(effect: Effect.Effect<A, E, ToolServices>) {
  return effect.pipe(
    Effect.provide(
      nativeToolTestLayer({
        workingDirectory: WORKSPACE_PATH,
        tracker,
        run: { runId, session: defaultSession(), toolPolicy: {} },
        onApprovalPolicyDenial: () => {
          policyDenials += 1;
        },
      }),
    ),
  );
}

describe('Tool edit approval gating', () => {
  beforeEach(async () => {
    await installPlatform();
    defaultSession().setApprovalPolicy('ask');
    policyDenials = 0;
    tracker = new FileInteractionState();
    defaultSession().approvals.clearAll();
    runId = publishTestRunStart(defaultSession(), generateRunId());
    await defaultSession().settlePublications();
    decisions = autoDecideRequests(defaultSession(), () => nextDecision());
  });

  afterEach(() => {
    decisions?.detach();
    decisions = undefined;
    vi.restoreAllMocks();
    detachHostInteractions();
    detachHostInteractions = () => {};
    defaultSession().approvals.clearAll();
  });

  it.effect('write_file applies changes after approval', () =>
    Effect.gen(function* () {
      const tool = new WriteFileTool();
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
      const tool = new WriteFileTool();
      const project = createFakeHost({
        workspacePath: path.resolve(path.sep, 'project'),
        config: { 'texra.toolUse.requireEditApproval': true },
      });
      const projectPath = project.roots.workspace!;
      const filePath = path.join(projectPath, 'scoped.txt');
      tracker.recordRead('scoped.txt');
      vi.spyOn(WorkspaceFS, 'exists').mockResolvedValue(true);
      vi.spyOn(WorkspaceFS, 'read').mockResolvedValue('old content');
      const write = vi.spyOn(WorkspaceFS, 'write').mockResolvedValue(undefined);

      const result = yield* tool
        .call({ path: filePath, content: 'new content' })
        .pipe(
          Effect.provide(
            nativeToolTestLayer({
              tracker,
              run: { runId, session: defaultSession(), toolPolicy: {} },
              inScope: (operation) =>
                runWithWorkspaceRoots(project.roots, operation),
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
      const tool = new WriteFileTool();
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
      assert.ok(result.userPatch);
      assert.strictEqual(result.edits?.[0]?.path, 'doc.txt');
      assert.strictEqual(result.edits?.[0]?.startLine, 1);
    }),
  );

  it.effect('write_file rejects when user denies approval', () =>
    Effect.gen(function* () {
      const tool = new WriteFileTool();
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
      const tool = new WriteFileTool();
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

  it.effect('preserves an automatic cancellation without a cause', () =>
    Effect.gen(function* () {
      const tool = new WriteFileTool();
      const write = stubWorkspaceFile('summary.txt', {
        exists: true,
        content: 'base',
      });
      nextDecision = () => ({ action: 'cancel', cause: undefined });

      const result = yield* inRun(
        tool.call({ path: 'summary.txt', content: 'new content' }),
      );

      assert.strictEqual(write.mock.calls.length, 0);
      assert.match(result.error ?? '', /Tool edit cancelled/);
      assert.doesNotMatch(result.error ?? '', /User rejected/);
      assert.strictEqual(result.userInstruction, undefined);
    }),
  );

  it.effect('write_file skips approval when disabled via config', () =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        installPlatform({ 'texra.toolUse.requireEditApproval': false }),
      );
      const tool = new WriteFileTool();
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
      defaultSession().setApprovalPolicy('never');

      const tool = new WriteFileTool();
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
      const tool = new WriteFileTool();
      const write = stubWorkspaceFile('doc.txt', {
        exists: false,
        content: '',
      });

      defaultSession().approvals.toolEdit.bypass.setBypass(runId, true, {
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

      defaultSession().approvals.toolEdit.bypass.setBypass(runId, true, {
        silent: true,
      });
      decideRequest(
        defaultSession(),
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
