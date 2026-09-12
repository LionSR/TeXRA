// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Node imports
import * as assert from 'node:assert';

// Third-party imports
import { Effect } from 'effect';
import { describe, it, beforeEach, afterEach, vi } from 'vitest';

// Local imports
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { effectRuntime } from '@platform/processRuntime';
import type { RequestDecision, RunId } from '@shared/schemas';
import { waitForCondition } from '@test/support/asyncTestUtils';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { WriteFileTool } from '@tools/WriteTool';
import {
  requestToolEditApproval,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { generateRunId } from '@utils/core';
import { WorkspaceFS } from '@utils/files/workspaceFS';

// Local file imports
import { autoDecideRequests, decideRequest } from '../agent/progressTestUtils';

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  effectRuntime().runPromise(effect);

// A tool edit opens its request on a run, so every case owns a freshly
// started one; the file's default session outlives the individual tests.
let runId: RunId;

// The decision a surface sends for each request the run opens; a case that
// must park one returns null and decides it later with `decideRequest`.
let nextDecision: () => RequestDecision | null = () => ({ action: 'approve' });
let decisions: ReturnType<typeof autoDecideRequests> | undefined;
let detachHostInteractions = (): void => {};
let policyDenials = 0;
// The previews the host staged; tests override the decision when they need to
// reject or adjust, and assert on this list otherwise.
let approvalRequests: ToolEditApprovalRequest[] = [];

async function installPlatform(
  config: Record<string, unknown> = {},
  files: Record<string, string | Uint8Array> = {},
) {
  approvalRequests = [];
  nextDecision = () => ({ action: 'approve' });
  await installFakePlatform({ workspacePath: '/workspace', config, files });
  detachHostInteractions();
  detachHostInteractions = defaultSession().interactions.use({
    presentToolEdit: (request) => {
      approvalRequests.push(request);
    },
  });
}

// Spies the workspace reads a tool performs before proposing an edit and
// returns the write spy so a test can inspect what was applied.
function stubWorkspaceFile(options: { exists: boolean; content: string }) {
  vi.spyOn(WorkspaceFS, 'exists').mockResolvedValue(options.exists);
  vi.spyOn(WorkspaceFS, 'read').mockResolvedValue(options.content);
  return vi.spyOn(WorkspaceFS, 'write').mockResolvedValue(undefined);
}

/** Run a tool call on the case's run, the way a dispatched tool does. */
function inRun<T>(call: () => Promise<T>): Promise<T> {
  return withRunContext(createRunContext({ runId }), call);
}

describe('Tool edit approval gating', () => {
  beforeEach(async () => {
    await installPlatform();
    defaultSession().setApprovalPolicy('ask');
    policyDenials = 0;
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

  it('write_file applies changes after approval', async () => {
    const tool = new WriteFileTool();
    const write = stubWorkspaceFile({ exists: true, content: 'old content' });

    const result = await inRun(() =>
      tool.call({ path: 'doc.txt', content: 'new content' }),
    );

    const [request] = approvalRequests;
    assert.strictEqual(request?.path, 'doc.txt');
    assert.strictEqual(request?.originalContent, 'old content');
    assert.strictEqual(request?.proposedContent, 'new content');
    assert.strictEqual(request?.sourceTool, 'write_file');
    assert.strictEqual(write.mock.lastCall?.[1], 'new content');
    assert.strictEqual(
      result.output,
      'written\n\nReplaced 1 lines with 1 lines.',
    );
    assert.strictEqual(result.userInstruction, undefined);
  });

  it('write_file reports the content adjusted during approval', async () => {
    const tool = new WriteFileTool();
    const write = stubWorkspaceFile({ exists: true, content: 'old content' });
    nextDecision = () => ({ action: 'approve', content: 'reviewed content' });

    const result = await inRun(() =>
      tool.call({ path: 'doc.txt', content: 'new content' }),
    );

    assert.strictEqual(write.mock.lastCall?.[1], 'reviewed content');
    assert.match(result.output ?? '', /User adjustments to doc\.txt/);
    assert.ok(result.userPatch);
    assert.strictEqual(result.edits?.[0]?.path, 'doc.txt');
    assert.strictEqual(result.edits?.[0]?.startLine, 1);
  });

  it('write_file rejects when user denies approval', async () => {
    const tool = new WriteFileTool();
    const write = stubWorkspaceFile({ exists: true, content: 'base' });

    nextDecision = () => ({ action: 'reject', feedback: 'Rejected by user' });

    const result = await inRun(() =>
      tool.call({ path: 'summary.txt', content: 'new content' }),
    );

    assert.strictEqual(write.mock.calls.length, 0);
    assert.strictEqual(result.status, 'error');
    assert.strictEqual(
      result.error,
      'User rejected write_file for summary.txt.',
    );
    assert.strictEqual(result.userInstruction, 'Rejected by user');
  });

  it('does not present an automatic cancellation as user feedback', async () => {
    const tool = new WriteFileTool();
    const write = stubWorkspaceFile({ exists: true, content: 'base' });
    nextDecision = () => ({ action: 'cancel', cause: 'Session disposed.' });

    const result = await inRun(() =>
      tool.call({ path: 'summary.txt', content: 'new content' }),
    );

    assert.strictEqual(write.mock.calls.length, 0);
    assert.match(result.error ?? '', /Tool edit cancelled/);
    assert.match(result.error ?? '', /Session disposed\./);
    assert.strictEqual(result.userInstruction, undefined);
  });

  it('preserves an automatic cancellation without a cause', async () => {
    const tool = new WriteFileTool();
    const write = stubWorkspaceFile({ exists: true, content: 'base' });
    nextDecision = () => ({ action: 'cancel', cause: undefined });

    const result = await inRun(() =>
      tool.call({ path: 'summary.txt', content: 'new content' }),
    );

    assert.strictEqual(write.mock.calls.length, 0);
    assert.match(result.error ?? '', /Tool edit cancelled/);
    assert.doesNotMatch(result.error ?? '', /User rejected/);
    assert.strictEqual(result.userInstruction, undefined);
  });

  it('write_file skips approval when disabled via config', async () => {
    await installPlatform({ 'texra.toolUse.requireEditApproval': false });
    const tool = new WriteFileTool();
    const write = stubWorkspaceFile({ exists: false, content: '' });

    const result = await inRun(() =>
      tool.call({ path: 'doc.txt', content: 'new content' }),
    );

    assert.strictEqual(approvalRequests.length, 0);
    assert.strictEqual(write.mock.lastCall?.[1], 'new content');
    assert.strictEqual(result.output, 'written');
  });

  it('lets never override a disabled approval setting', async () => {
    await installPlatform({ 'texra.toolUse.requireEditApproval': false });
    defaultSession().setApprovalPolicy('never');

    const tool = new WriteFileTool();
    const write = stubWorkspaceFile({ exists: false, content: '' });

    const result = await withRunContext(
      createRunContext({
        onApprovalPolicyDenial: () => {
          policyDenials += 1;
        },
      }),
      () => tool.call({ path: 'denied.txt', content: 'blocked' }),
    );

    assert.strictEqual(approvalRequests.length, 0);
    assert.strictEqual(write.mock.calls.length, 0);
    assert.strictEqual(result.status, 'error');
    assert.strictEqual(result.userInstruction, undefined);
    assert.match(result.error ?? '', /Denied by TeXRA approval policy\./);
    assert.strictEqual(policyDenials, 1);
  });

  it('session bypass auto-approves pending requests', async () => {
    const tool = new WriteFileTool();
    const write = stubWorkspaceFile({ exists: false, content: '' });

    defaultSession().approvals.toolEdit.bypass.setBypass(runId, true, {
      silent: true,
    });

    // The bypass check requires a runId on the request; the approval layer
    // picks it up from the active run context.
    const result = await inRun(() =>
      tool.call({ path: 'doc.txt', content: 'auto' }),
    );

    assert.strictEqual(approvalRequests.length, 0);
    assert.strictEqual(write.mock.lastCall?.[1], 'auto');
    assert.strictEqual(result.output, 'written');
  });

  it('rechecks session bypass between concurrent approval requests', async () => {
    // The first request stays parked so the second is enqueued behind it.
    nextDecision = () => null;

    const requestInRun = (path: string): Promise<ToolEditApprovalResult> =>
      withRunContext(createRunContext({ runId }), () =>
        run(
          requestToolEditApproval({
            path,
            originalContent: '',
            proposedContent: path,
            sourceTool: 'write_file',
          }),
        ),
      );

    const firstRequest = requestInRun('first.txt');
    const secondRequest = requestInRun('second.txt');
    await waitForCondition(() => approvalRequests.length === 1, {
      timeoutMessage: 'Timed out waiting for the first edit to be staged',
    });

    defaultSession().approvals.toolEdit.bypass.setBypass(runId, true, {
      silent: true,
    });
    decideRequest(
      defaultSession(),
      { runId, requestId: approvalRequests[0]!.permission.requestId },
      { action: 'approve', content: 'first.txt' },
    );

    const results = await Promise.all([firstRequest, secondRequest]);
    assert.deepStrictEqual(
      results.map((result) => result.action),
      ['apply', 'apply'],
    );
    // The bypassed second request never reaches a surface.
    assert.strictEqual(approvalRequests.length, 1);
  });
});
