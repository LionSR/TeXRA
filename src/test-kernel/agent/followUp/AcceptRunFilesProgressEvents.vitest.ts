// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { installPlatform } from '@test/support/setupPlatform';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { withToolFileInteractionContext } from '@agent/followUp/ToolFileInteractionContext';
import { appSignals } from '@eventBus/AppSignals';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { AcceptRunFilesTool } from '@tools/AcceptRunFilesTool';
import {
  cleanupAllApprovals,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval';
import { AbsoluteFS, FlexibleFS, StorageFS, WorkspaceFS } from '@utils/files';
import { createRecordingHost } from '../progressTestUtils';

let testApprovalHandler:
  | ((request: ToolEditApprovalRequest) => Promise<ToolEditApprovalResult>)
  | undefined;

function installTestPlatform(): Promise<void> {
  return installPlatform({
    workspacePath,
    storagePath,
    globalStoragePath: '/global/.texra/storage',
  }).then(() => {
    defaultSession().useHostInteractions({
      requestToolEditApproval: (request) => {
        const handler = testApprovalHandler;
        if (!handler) {
          throw new Error('No test handler. Set `testApprovalHandler`.');
        }
        return handler(request);
      },
      resolve: () => false,
      cancel: () => undefined,
    });
  });
}

const executionId = 'abcdef' as ExecutionId;
const streamId = 'stream:accept-run-files' as StreamTabId;
const workspacePath = '/workspace';
const storagePath = '/storage';

function runAccept(
  tool: AcceptRunFilesTool,
  host: AgentRuntimeHost,
  files: { path: string; original: string }[],
) {
  return withRunContext(
    createRunContext({ runtimeHost: host, streamId, executionId }),
    () =>
      withToolFileInteractionContext({ tracker: {} as never }, () =>
        tool.call({ execution_id: executionId, files }),
      ),
  );
}

describe('accept_run_files progress events', () => {
  let originalStorageExists: typeof StorageFS.exists;
  let originalStorageFullPath: typeof StorageFS.fullPath;
  let originalWorkspaceLocatePath: typeof WorkspaceFS.locatePath;
  let originalWorkspaceExists: typeof WorkspaceFS.exists;
  let originalWorkspaceRead: typeof WorkspaceFS.read;
  let originalWorkspaceWrite: typeof WorkspaceFS.write;
  let originalWorkspaceDelete: typeof WorkspaceFS.delete;
  let originalAbsoluteIsFile: typeof AbsoluteFS.isFile;
  let originalAbsoluteIsSymbolicLink: typeof AbsoluteFS.isSymbolicLink;
  let originalAbsoluteRead: typeof AbsoluteFS.read;
  let originalFlexibleRead: typeof FlexibleFS.read;

  beforeEach(async () => {
    originalStorageExists = StorageFS.exists;
    originalStorageFullPath = StorageFS.fullPath;
    originalWorkspaceLocatePath = WorkspaceFS.locatePath;
    originalWorkspaceExists = WorkspaceFS.exists;
    originalWorkspaceRead = WorkspaceFS.read;
    originalWorkspaceWrite = WorkspaceFS.write;
    originalWorkspaceDelete = WorkspaceFS.delete;
    originalAbsoluteIsFile = AbsoluteFS.isFile;
    originalAbsoluteIsSymbolicLink = AbsoluteFS.isSymbolicLink;
    originalAbsoluteRead = AbsoluteFS.read;
    originalFlexibleRead = FlexibleFS.read;
    AbsoluteFS.isSymbolicLink = async () => false;
    testApprovalHandler = undefined;
    await installTestPlatform();
    cleanupAllApprovals();
    // Shared by every test below that stubs the execution/workspace paths;
    // the test that doesn't need it (missing runtime host) fails before
    // reaching either function.
    StorageFS.fullPath = (target) => `${storagePath}/${target}`;
    WorkspaceFS.locatePath = (target) => ({
      kind: 'workspace',
      absolutePath: `${workspacePath}/${target}`,
      relativePath: target,
    });
  });

  afterEach(() => {
    StorageFS.exists = originalStorageExists;
    StorageFS.fullPath = originalStorageFullPath;
    WorkspaceFS.locatePath = originalWorkspaceLocatePath;
    WorkspaceFS.exists = originalWorkspaceExists;
    WorkspaceFS.read = originalWorkspaceRead;
    WorkspaceFS.write = originalWorkspaceWrite;
    WorkspaceFS.delete = originalWorkspaceDelete;
    AbsoluteFS.isFile = originalAbsoluteIsFile;
    AbsoluteFS.isSymbolicLink = originalAbsoluteIsSymbolicLink;
    AbsoluteFS.read = originalAbsoluteRead;
    FlexibleFS.read = originalFlexibleRead;
    testApprovalHandler = undefined;
    defaultSession().interactions.dispose();
    cleanupAllApprovals();
  });

  it('publishes accepted workspace files through app signals', async () => {
    const explicit = createRecordingHost();
    const tool = new AcceptRunFilesTool();
    const written: string[][] = [];
    const dispose = appSignals.on(
      'workspaceFilesWritten',
      ({ absolutePaths }) => {
        written.push(absolutePaths);
      },
    );

    StorageFS.exists = async (target) =>
      target === `executions/${executionId}` ||
      target === `executions/${executionId}/output.tex`;
    WorkspaceFS.exists = async () => false;
    WorkspaceFS.read = async () => '';
    WorkspaceFS.write = async () => undefined;
    WorkspaceFS.delete = async () => undefined;
    FlexibleFS.read = async () => 'accepted content';

    testApprovalHandler = async () => ({ accepted: true });

    const result = await runAccept(tool, explicit.host, [
      { path: 'output.tex', original: 'paper.tex' },
    ]);

    expect(result.status).toBe('executed');
    expect(explicit.events).toEqual([]);
    expect(written).toEqual([[`${workspacePath}/paper.tex`]]);
    dispose();
  });

  it('does not require a runtime host to publish accepted workspace files', async () => {
    const tool = new AcceptRunFilesTool();
    let writes = 0;
    const written: string[][] = [];
    const dispose = appSignals.on(
      'workspaceFilesWritten',
      ({ absolutePaths }) => {
        written.push(absolutePaths);
      },
    );

    StorageFS.exists = async (target) =>
      target === `executions/${executionId}` ||
      target === `executions/${executionId}/output.tex`;
    WorkspaceFS.exists = async () => false;
    WorkspaceFS.read = async () => '';
    WorkspaceFS.write = async () => {
      writes++;
    };
    WorkspaceFS.delete = async () => undefined;
    FlexibleFS.read = async () => 'accepted content';
    testApprovalHandler = async () => ({ accepted: true });

    const result = await tool.call({
      execution_id: executionId,
      files: [{ path: 'output.tex', original: 'paper.tex' }],
    });

    expect(result.status).toBe('executed');
    expect(writes).toBe(1);
    expect(written).toEqual([[`${workspacePath}/paper.tex`]]);
    dispose();
  });

  it('uses the pre-run snapshot for same-path workspace outputs', async () => {
    const explicit = createRecordingHost();
    const tool = new AcceptRunFilesTool();
    let approvalOriginal = '';
    let approvalProposed = '';
    let writes = 0;

    StorageFS.exists = async (target) => target === `executions/${executionId}`;
    WorkspaceFS.exists = async () => true;
    WorkspaceFS.read = async () => 'new content';
    WorkspaceFS.write = async () => {
      writes++;
    };
    WorkspaceFS.delete = async () => undefined;
    AbsoluteFS.isFile = async (target) =>
      target === `${storagePath}/executions/${executionId}/original/draft.tex`;
    AbsoluteFS.read = async () => 'old content';
    FlexibleFS.read = async () => 'new content';
    testApprovalHandler = async (request) => {
      approvalOriginal = request.originalContent;
      approvalProposed = request.proposedContent;
      return { accepted: true };
    };

    const result = await runAccept(tool, explicit.host, [
      { path: 'draft.tex', original: 'draft.tex' },
    ]);

    expect(result.status).toBe('executed');
    expect(approvalOriginal).toBe('old content');
    expect(approvalProposed).toBe('new content');
    expect(result.edits?.[0]?.lineChanges).toEqual({
      added: 1,
      removed: 1,
    });
    expect(writes).toBe(0);
  });

  it('reports unchanged same-path fallbacks without approval', async () => {
    const explicit = createRecordingHost();
    const tool = new AcceptRunFilesTool();
    let approvals = 0;
    let writes = 0;

    StorageFS.exists = async (target) => target === `executions/${executionId}`;
    WorkspaceFS.exists = async () => true;
    WorkspaceFS.read = async () => 'same content';
    WorkspaceFS.write = async () => {
      writes++;
    };
    WorkspaceFS.delete = async () => undefined;
    AbsoluteFS.isFile = async () => false;
    FlexibleFS.read = async () => 'same content';
    testApprovalHandler = async () => {
      approvals++;
      return { accepted: true };
    };

    const result = await runAccept(tool, explicit.host, [
      { path: 'draft.tex', original: 'draft.tex' },
    ]);

    expect(result.status).toBe('executed');
    expect(result.output).toContain('No changes to accept');
    expect(result.output).toContain('unchanged: draft.tex');
    expect(approvals).toBe(0);
    expect(writes).toBe(0);
    expect(explicit.events).toEqual([]);
  });

  it('refuses symlinked run-storage entries so unemitted files cannot be accepted', async () => {
    const explicit = createRecordingHost();
    const tool = new AcceptRunFilesTool();
    let approvals = 0;
    let writes = 0;

    StorageFS.exists = async (target) =>
      target === `executions/${executionId}` ||
      target === `executions/${executionId}/r1/Draft/appendices.tex`;
    WorkspaceFS.exists = async () => true;
    WorkspaceFS.read = async () => '';
    WorkspaceFS.write = async () => {
      writes++;
    };
    WorkspaceFS.delete = async () => undefined;
    AbsoluteFS.isSymbolicLink = async (target) =>
      target ===
      `${storagePath}/executions/${executionId}/r1/Draft/appendices.tex`;
    testApprovalHandler = async () => {
      approvals++;
      return { accepted: true };
    };

    const result = await runAccept(tool, explicit.host, [
      { path: 'r1/Draft/appendices.tex', original: 'Draft/appendices.tex' },
    ]);

    expect(result.status).toBe('error');
    expect(result.error).toContain('symlink');
    expect(result.error).toContain('did not emit');
    expect(approvals).toBe(0);
    expect(writes).toBe(0);
    expect(explicit.events).toEqual([]);
  });
});
