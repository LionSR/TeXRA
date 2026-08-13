// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Node imports
import * as assert from 'node:assert';

// Third-party imports
import pDefer from 'p-defer';
import { describe, it, beforeEach, afterEach, vi } from 'vitest';

// Local imports
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession } from '@agent/runtime/SessionHandle';
import type { StreamTabId } from '@shared/schemas';
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';
import { TextEditorTool } from '@tools/TextEditorTool';
import { WriteFileTool } from '@tools/WriteTool';
import {
  cleanupAllApprovals,
  setToolEditApprovalSessionBypass,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval';
import { requestToolEditApproval } from '@tools/approval/toolEditApproval';
import { WorkspaceFS } from '@utils/files/workspaceFS';

// Test stream ID for the per-stream approval-bypass cases
const TEST_STREAM_ID = 'TestAgent@model: test.tex' as StreamTabId;

// Host interactions are attached once per platform install, so each case swaps
// this reference and the attached port delegates to whatever it holds.
let testApprovalHandler:
  | ((request: ToolEditApprovalRequest) => Promise<ToolEditApprovalResult>)
  | undefined;
let detachHostInteractions = (): void => {};
let policyDenials = 0;
// Requests the default auto-approve handler saw; tests override the handler
// when they need to deny or adjust, and assert on this list otherwise.
let approvalRequests: ToolEditApprovalRequest[] = [];

async function installPlatform(
  config: Record<string, unknown> = {},
  files: Record<string, string | Uint8Array> = {},
) {
  approvalRequests = [];
  testApprovalHandler = async (request) => {
    approvalRequests.push(request);
    return { accepted: true, appliedContent: request.proposedContent };
  };
  await installFakePlatform({ workspacePath: '/workspace', config, files });
  detachHostInteractions();
  detachHostInteractions = defaultSession().useHostInteractions({
    requestToolEditApproval: (request) => {
      const handler = testApprovalHandler;
      if (!handler) {
        throw new Error(
          'No test approval handler configured. Set `testApprovalHandler` first.',
        );
      }
      return handler(request);
    },
    cancel: () => undefined,
  });
}

// Spies the workspace reads a tool performs before proposing an edit and
// returns the write spy so a test can inspect what was applied.
function stubWorkspaceFile(options: { exists: boolean; content: string }) {
  vi.spyOn(WorkspaceFS, 'exists').mockResolvedValue(options.exists);
  vi.spyOn(WorkspaceFS, 'read').mockResolvedValue(options.content);
  return vi.spyOn(WorkspaceFS, 'write').mockResolvedValue(undefined);
}

describe('Tool edit approval gating', () => {
  beforeEach(async () => {
    await installPlatform();
    defaultSession().setApprovalPolicy('ask');
    policyDenials = 0;
    cleanupAllApprovals();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testApprovalHandler = undefined;
    detachHostInteractions();
    detachHostInteractions = () => {};
    cleanupAllApprovals();
  });

  it('write_file applies changes after approval', async () => {
    const tool = new WriteFileTool();
    const write = stubWorkspaceFile({ exists: true, content: 'old content' });

    const result = await tool.call({ path: 'doc.txt', content: 'new content' });

    const [request] = approvalRequests;
    assert.strictEqual(request?.path, 'doc.txt');
    assert.strictEqual(request?.originalContent, 'old content');
    assert.strictEqual(request?.proposedContent, 'new content');
    assert.strictEqual(request?.sourceTool, 'write_file');
    assert.strictEqual(write.mock.lastCall?.[1], 'new content');
    assert.strictEqual(result.output, 'written');
  });

  it('write_file reports the content adjusted during approval', async () => {
    const tool = new WriteFileTool();
    const write = stubWorkspaceFile({ exists: true, content: 'old content' });
    testApprovalHandler = async () => ({
      accepted: true,
      appliedContent: 'reviewed content',
    });

    const result = await tool.call({ path: 'doc.txt', content: 'new content' });

    assert.strictEqual(write.mock.lastCall?.[1], 'reviewed content');
    assert.match(result.output ?? '', /User adjustments to doc\.txt/);
    assert.ok(result.userPatch);
    assert.strictEqual(result.edits?.[0]?.path, 'doc.txt');
    assert.strictEqual(result.edits?.[0]?.startLine, 1);
  });

  it('write_file rejects when user denies approval', async () => {
    const tool = new WriteFileTool();
    const write = stubWorkspaceFile({ exists: true, content: 'base' });

    testApprovalHandler = async () => ({
      accepted: false,
      userMessage: 'Rejected by user',
    });

    const result = await tool.call({
      path: 'summary.txt',
      content: 'new content',
    });

    assert.strictEqual(write.mock.calls.length, 0);
    assert.strictEqual(result.status, 'error');
    assert.strictEqual(
      result.error,
      'User rejected write_file for summary.txt.',
    );
    assert.strictEqual(result.userInstruction, 'Rejected by user');
  });

  it('write_file skips approval when disabled via config', async () => {
    await installPlatform({ 'texra.toolUse.requireEditApproval': false });
    const tool = new WriteFileTool();
    const write = stubWorkspaceFile({ exists: false, content: '' });

    const result = await tool.call({ path: 'doc.txt', content: 'new content' });

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
    assert.strictEqual(
      result.userInstruction,
      'Denied by TeXRA approval policy.',
    );
    assert.strictEqual(policyDenials, 1);
  });

  it('session bypass auto-approves pending requests', async () => {
    const tool = new WriteFileTool();
    const write = stubWorkspaceFile({ exists: false, content: '' });

    setToolEditApprovalSessionBypass(TEST_STREAM_ID, true, { silent: true });

    // The bypass check requires a streamId on the request; the approval layer
    // picks it up from the active run context.
    const result = await withRunContext(
      createRunContext({
        streamId: TEST_STREAM_ID,
      }),
      () => tool.call({ path: 'doc.txt', content: 'auto' }),
    );

    assert.strictEqual(approvalRequests.length, 0);
    assert.strictEqual(write.mock.lastCall?.[1], 'auto');
    assert.strictEqual(result.output, 'written');
  });

  it('rechecks session bypass between concurrent approval requests', async () => {
    const firstApproval = pDefer<ToolEditApprovalResult>();
    const firstPrompted = pDefer<void>();
    let handlerCalls = 0;

    testApprovalHandler = async () => {
      handlerCalls += 1;
      firstPrompted.resolve();
      return firstApproval.promise;
    };

    const requestInStream = (path: string) =>
      withRunContext(
        createRunContext({
          streamId: TEST_STREAM_ID,
        }),
        () =>
          requestToolEditApproval({
            path,
            originalContent: '',
            proposedContent: path,
            sourceTool: 'write_file',
          }),
      );

    const firstRequest = requestInStream('first.txt');
    const secondRequest = requestInStream('second.txt');
    await firstPrompted.promise;

    assert.strictEqual(handlerCalls, 1);
    setToolEditApprovalSessionBypass(TEST_STREAM_ID, true, { silent: true });
    firstApproval.resolve({ accepted: true, appliedContent: 'first.txt' });

    const results = await Promise.all([firstRequest, secondRequest]);
    assert.deepStrictEqual(
      results.map((result) => result.accepted),
      [true, true],
    );
    assert.strictEqual(handlerCalls, 1);
  });

  it('text editor str_replace rejects an empty old_str before approval', async () => {
    await installPlatform(
      {},
      {
        '/workspace/shared.tex': 'alpha\n',
      },
    );
    const tool = new TextEditorTool();

    testApprovalHandler = async () => {
      throw new Error('approval should not be requested');
    };

    const result = await tool.call({
      command: 'str_replace',
      path: 'shared.tex',
      old_str: '',
      new_str: 'beta',
    });

    assert.strictEqual(result.status, 'error');
    assert.match(result.error ?? '', /old_str must not be empty/);
    assert.strictEqual(await WorkspaceFS.read('shared.tex'), 'alpha\n');
  });
});
