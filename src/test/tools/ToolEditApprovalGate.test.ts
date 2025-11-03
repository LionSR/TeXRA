import * as assert from 'assert';

import { WriteFileTool } from '../../tools/WriteTool';
import { FileOpTool } from '../../tools/fileOp';
import {
  setToolEditApprovalHandler,
  type ToolEditApprovalRequest,
} from '../../tools/approval/toolEditApproval';
import * as configModule from '../../utils/config';
import { WorkspaceFS } from '../../utils/files';

suite('Tool edit approval gating', () => {
  let originalExists: typeof WorkspaceFS.exists;
  let originalRead: typeof WorkspaceFS.read;
  let originalWrite: typeof WorkspaceFS.write;
  let originalGetConfig: typeof configModule.getConfig;

  setup(() => {
    originalExists = WorkspaceFS.exists;
    originalRead = WorkspaceFS.read;
    originalWrite = WorkspaceFS.write;
    originalGetConfig = configModule.getConfig;
  });

  teardown(() => {
    WorkspaceFS.exists = originalExists;
    WorkspaceFS.read = originalRead;
    WorkspaceFS.write = originalWrite;
    (configModule as { getConfig: typeof originalGetConfig }).getConfig =
      originalGetConfig;
    setToolEditApprovalHandler();
  });

  test('write_file applies changes after approval', async () => {
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

  test('file_op append aborts when change is rejected', async () => {
    const tool = new FileOpTool();
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
      command: 'append',
      path: 'summary.txt',
      content: ' new text',
    });

    assert.strictEqual(writeCalled, false);
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.error, 'Rejected by user');
  });

  test('write_file skips approval when disabled via config', async () => {
    const tool = new WriteFileTool();
    let handlerCalled = false;
    let writtenContent: string | undefined;

    WorkspaceFS.exists = async () => false;
    WorkspaceFS.read = async () => '';
    WorkspaceFS.write = async (_path: string, content: string) => {
      writtenContent = content;
    };

    (configModule as { getConfig: typeof originalGetConfig }).getConfig = (<T>(
      key: string,
      defaultValue?: T,
    ) => {
      if (key === 'texra.toolUse.requireEditApproval') {
        return false as T;
      }
      return originalGetConfig(key, defaultValue);
    }) as typeof configModule.getConfig;

    setToolEditApprovalHandler(async () => {
      handlerCalled = true;
      return { accepted: true };
    });

    const result = await tool.call({ path: 'doc.txt', content: 'new content' });

    assert.strictEqual(handlerCalled, false);
    assert.strictEqual(writtenContent, 'new content');
    assert.strictEqual(result.output, 'written');
  });
});
