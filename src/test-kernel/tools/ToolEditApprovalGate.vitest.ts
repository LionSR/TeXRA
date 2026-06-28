// Third-party imports
import * as assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'vitest';

// Local imports - tests
import { createFakePlatform } from '@test/support/FakePlatform';

// Local imports - agent types
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { noopAgentRuntimeHost } from '@hosts/AgentRuntimeHost';

// Local imports - tools
import type { StreamTabId } from '@shared/schemas';
import { TextEditorTool } from '@tools/TextEditorTool';
import { WriteFileTool } from '@tools/WriteTool';
import {
  cleanupAllApprovals,
  setToolEditApprovalHandler,
  setToolEditApprovalSessionBypass,
  toggleToolEditApprovalSessionBypass,
  type ToolEditApprovalRequest,
} from '@tools/approval';
import { WorkspaceFS } from '@utils/files';

// Test stream ID for per-stream YOLO mode tests
const TEST_STREAM_ID = 'TestAgent@model: test.tex' as StreamTabId;

async function installPlatform(
  config: Record<string, unknown> = {},
  files: Record<string, string | Uint8Array> = {},
) {
  const { initPlatform } = await import('@platform/platform');
  initPlatform(
    createFakePlatform({ workspacePath: '/workspace', config, files }),
  );
}

async function callTextEditorInRun(
  tool: TextEditorTool,
  executionId: string,
  input: unknown,
) {
  return withRunContext(
    createRunContext({
      runtimeHost: noopAgentRuntimeHost,
      streamId: `stream:${executionId}` as StreamTabId,
      executionId,
    }),
    () => tool.call(input),
  );
}

describe('Tool edit approval gating', () => {
  let originalExists: typeof WorkspaceFS.exists;
  let originalRead: typeof WorkspaceFS.read;
  let originalWrite: typeof WorkspaceFS.write;
  let originalAppend: typeof WorkspaceFS.appendFile;

  beforeEach(async () => {
    originalExists = WorkspaceFS.exists;
    originalRead = WorkspaceFS.read;
    originalWrite = WorkspaceFS.write;
    originalAppend = WorkspaceFS.appendFile;
    await installPlatform();
    cleanupAllApprovals();
  });

  afterEach(() => {
    WorkspaceFS.exists = originalExists;
    WorkspaceFS.read = originalRead;
    WorkspaceFS.write = originalWrite;
    WorkspaceFS.appendFile = originalAppend;
    setToolEditApprovalHandler();
    cleanupAllApprovals();
  });

  it('write_file applies changes after approval', async () => {
    const tool = new WriteFileTool();
    let capturedRequest: ToolEditApprovalRequest | undefined;
    let writtenContent: string | undefined;

    WorkspaceFS.exists = async () => true;
    WorkspaceFS.read = async () => 'old content';
    WorkspaceFS.write = async (_path: string, content: string) => {
      writtenContent = content;
    };

    setToolEditApprovalHandler(async (request) => {
      capturedRequest = request;
      return { accepted: true };
    });

    const result = await tool.call({ path: 'doc.txt', content: 'new content' });

    assert.strictEqual(capturedRequest?.path, 'doc.txt');
    assert.strictEqual(capturedRequest?.originalContent, 'old content');
    assert.strictEqual(capturedRequest?.proposedContent, 'new content');
    assert.strictEqual(capturedRequest?.sourceTool, 'write_file');
    assert.strictEqual(writtenContent, 'new content');
    assert.strictEqual(result.output, 'written');
  });

  it('write_file rejects when user denies approval', async () => {
    const tool = new WriteFileTool();
    let writeCalled = false;

    WorkspaceFS.exists = async () => true;
    WorkspaceFS.read = async () => 'base';
    WorkspaceFS.write = async () => {
      writeCalled = true;
    };

    setToolEditApprovalHandler(async () => ({
      accepted: false,
      userMessage: 'Rejected by user',
    }));

    const result = await tool.call({
      path: 'summary.txt',
      content: 'new content',
    });

    assert.strictEqual(writeCalled, false);
    assert.strictEqual(result.isError, true);
    assert.strictEqual(
      result.error,
      'User rejected write_file for summary.txt.',
    );
    assert.strictEqual(result.userInstruction, 'Rejected by user');
  });

  it('write_file skips approval when disabled via config', async () => {
    await installPlatform({ 'texra.toolUse.requireEditApproval': false });

    const tool = new WriteFileTool();
    let handlerCalled = false;
    let writtenContent: string | undefined;

    WorkspaceFS.exists = async () => false;
    WorkspaceFS.read = async () => '';
    WorkspaceFS.write = async (_path: string, content: string) => {
      writtenContent = content;
    };

    setToolEditApprovalHandler(async () => {
      handlerCalled = true;
      return { accepted: true };
    });

    const result = await tool.call({ path: 'doc.txt', content: 'new content' });

    assert.strictEqual(handlerCalled, false);
    assert.strictEqual(writtenContent, 'new content');
    assert.strictEqual(result.output, 'written');
  });

  it('session bypass auto-approves pending requests', async () => {
    const tool = new WriteFileTool();
    let handlerCalled = false;
    let writtenContent: string | undefined;

    WorkspaceFS.exists = async () => false;
    WorkspaceFS.read = async () => '';
    WorkspaceFS.write = async (_path: string, content: string) => {
      writtenContent = content;
    };

    setToolEditApprovalHandler(async () => {
      handlerCalled = true;
      return { accepted: true };
    });

    setToolEditApprovalSessionBypass(
      TEST_STREAM_ID,
      true,
      noopAgentRuntimeHost,
      { silent: true },
    );

    // The bypass check requires a streamId on the request; the approval layer
    // picks it up from the active run context.
    const result = await withRunContext(
      createRunContext({
        runtimeHost: noopAgentRuntimeHost,
        streamId: TEST_STREAM_ID,
      }),
      () => tool.call({ path: 'doc.txt', content: 'auto' }),
    );

    assert.strictEqual(handlerCalled, false);
    assert.strictEqual(writtenContent, 'auto');
    assert.strictEqual(result.output, 'written');
  });

  it('keeps text editor undo history isolated between execution ids', async () => {
    await installPlatform(
      {},
      {
        '/workspace/shared.tex': 'alpha\n',
      },
    );
    const tool = new TextEditorTool();

    setToolEditApprovalHandler(async () => ({ accepted: true }));

    const parentEdit = await callTextEditorInRun(tool, 'aaaaaa', {
      command: 'str_replace',
      path: 'shared.tex',
      old_str: 'alpha',
      new_str: 'parent',
    });
    assert.notStrictEqual(parentEdit.isError, true);
    assert.strictEqual(await WorkspaceFS.read('shared.tex'), 'parent\n');

    const childEdit = await callTextEditorInRun(tool, 'bbbbbb', {
      command: 'str_replace',
      path: 'shared.tex',
      old_str: 'parent',
      new_str: 'child',
    });
    assert.notStrictEqual(childEdit.isError, true);
    assert.strictEqual(await WorkspaceFS.read('shared.tex'), 'child\n');

    const parentUndo = await callTextEditorInRun(tool, 'aaaaaa', {
      command: 'undo_edit',
      path: 'shared.tex',
    });
    assert.notStrictEqual(parentUndo.isError, true);
    assert.strictEqual(await WorkspaceFS.read('shared.tex'), 'alpha\n');

    const childUndo = await callTextEditorInRun(tool, 'bbbbbb', {
      command: 'undo_edit',
      path: 'shared.tex',
    });
    assert.notStrictEqual(childUndo.isError, true);
    assert.strictEqual(await WorkspaceFS.read('shared.tex'), 'parent\n');
  });

  it('toggleToolEditApprovalSessionBypass toggles state and returns new value', () => {
    // Test toggle mechanics (per-stream state)
    // Initially bypass is off (cleared in beforeEach)

    // Toggle on - should return true
    const enabledState = toggleToolEditApprovalSessionBypass(
      TEST_STREAM_ID,
      noopAgentRuntimeHost,
    );
    assert.strictEqual(enabledState, true, 'Toggle returns true when enabling');

    // Toggle off - should return false
    const disabledState = toggleToolEditApprovalSessionBypass(
      TEST_STREAM_ID,
      noopAgentRuntimeHost,
    );
    assert.strictEqual(
      disabledState,
      false,
      'Toggle returns false when disabling',
    );

    // Toggle on again
    const reenabledState = toggleToolEditApprovalSessionBypass(
      TEST_STREAM_ID,
      noopAgentRuntimeHost,
    );
    assert.strictEqual(
      reenabledState,
      true,
      'Toggle returns true when re-enabling',
    );
  });
});
