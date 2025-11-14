// Third-party imports
import * as assert from 'assert';

// Local imports - tools
import { WriteFileTool } from '@tools/WriteTool';
import { FileOpTool } from '@tools/fileOp';
import {
  setToolEditApprovalHandler,
  setToolEditApprovalSessionBypass,
  type ToolEditApprovalRequest,
} from '@tools/approval/toolEditApproval';
import * as configModule from '@utils/config';
import { WorkspaceFS } from '@utils/files';

describe('Tool edit approval gating', () => {
  let originalExists: typeof WorkspaceFS.exists;
  let originalRead: typeof WorkspaceFS.read;
  let originalWrite: typeof WorkspaceFS.write;
  let originalAppend: typeof WorkspaceFS.appendFile;
  let originalGetConfig: typeof configModule.getConfig;

  beforeEach(() => {
    originalExists = WorkspaceFS.exists;
    originalRead = WorkspaceFS.read;
    originalWrite = WorkspaceFS.write;
    originalAppend = WorkspaceFS.appendFile;
    originalGetConfig = configModule.getConfig;
    setToolEditApprovalSessionBypass(false);
  });

  afterEach(() => {
    WorkspaceFS.exists = originalExists;
    WorkspaceFS.read = originalRead;
    WorkspaceFS.write = originalWrite;
    WorkspaceFS.appendFile = originalAppend;
    (configModule as { getConfig: typeof originalGetConfig }).getConfig =
      originalGetConfig;
    setToolEditApprovalHandler();
    setToolEditApprovalSessionBypass(false);
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

  it('file_op append aborts when change is rejected', async () => {
    const tool = new FileOpTool();
    let appendCalled = false;

    WorkspaceFS.exists = async () => true;
    WorkspaceFS.read = async () => 'base';
    WorkspaceFS.appendFile = async () => {
      appendCalled = true;
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

    assert.strictEqual(appendCalled, false);
    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.error, 'Rejected by user');
  });

  it('write_file skips approval when disabled via config', async () => {
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

    setToolEditApprovalSessionBypass(true);

    const result = await tool.call({ path: 'doc.txt', content: 'auto' });

    assert.strictEqual(handlerCalled, false);
    assert.strictEqual(writtenContent, 'auto');
    assert.strictEqual(result.output, 'written');
  });
});
