// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import {
  getDefaultAgentRuntimeHost,
  setDefaultAgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { withToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { AcceptRunFilesTool } from '@tools/AcceptRunFilesTool';
import {
  cleanupAllApprovals,
  setToolEditApprovalHandler,
} from '@tools/approval';
import { flexibleFS, StorageFS, WorkspaceFS } from '@utils/files';
import { createRecordingHost } from '../progressTestUtils';

const executionId = 'abcdef' as ExecutionId;
const streamId = 'stream:accept-run-files' as StreamTabId;
const workspacePath = '/workspace';
const storagePath = '/storage';

describe('accept_run_files progress events', () => {
  let originalStorageExists: typeof StorageFS.exists;
  let originalStorageFullPath: typeof StorageFS.fullPath;
  let originalWorkspaceLocatePath: typeof WorkspaceFS.locatePath;
  let originalWorkspaceExists: typeof WorkspaceFS.exists;
  let originalWorkspaceRead: typeof WorkspaceFS.read;
  let originalWorkspaceWrite: typeof WorkspaceFS.write;
  let originalWorkspaceDelete: typeof WorkspaceFS.delete;
  let originalFlexibleRead: typeof flexibleFS.read;

  beforeEach(() => {
    originalStorageExists = StorageFS.exists;
    originalStorageFullPath = StorageFS.fullPath;
    originalWorkspaceLocatePath = WorkspaceFS.locatePath;
    originalWorkspaceExists = WorkspaceFS.exists;
    originalWorkspaceRead = WorkspaceFS.read;
    originalWorkspaceWrite = WorkspaceFS.write;
    originalWorkspaceDelete = WorkspaceFS.delete;
    originalFlexibleRead = flexibleFS.read;
    cleanupAllApprovals();
  });

  afterEach(() => {
    StorageFS.exists = originalStorageExists;
    StorageFS.fullPath = originalStorageFullPath;
    WorkspaceFS.locatePath = originalWorkspaceLocatePath;
    WorkspaceFS.exists = originalWorkspaceExists;
    WorkspaceFS.read = originalWorkspaceRead;
    WorkspaceFS.write = originalWorkspaceWrite;
    WorkspaceFS.delete = originalWorkspaceDelete;
    flexibleFS.read = originalFlexibleRead;
    setToolEditApprovalHandler();
    cleanupAllApprovals();
  });

  it('publishes accepted workspace files through the tool runtime host', async () => {
    const explicit = createRecordingHost();
    const fallback = createRecordingHost();
    const previousDefault = getDefaultAgentRuntimeHost();
    const tool = new AcceptRunFilesTool();

    try {
      setDefaultAgentRuntimeHost(fallback.host);

      StorageFS.exists = async (target) =>
        target === `executions/${executionId}` ||
        target === `executions/${executionId}/output.tex`;
      StorageFS.fullPath = (target) => `${storagePath}/${target}`;
      WorkspaceFS.locatePath = (target) => ({
        kind: 'workspace',
        absolutePath: `${workspacePath}/${target}`,
        relativePath: target,
      });
      WorkspaceFS.exists = async () => false;
      WorkspaceFS.read = async () => '';
      WorkspaceFS.write = async () => undefined;
      WorkspaceFS.delete = async () => undefined;
      flexibleFS.read = async () => 'accepted content';

      setToolEditApprovalHandler(async () => ({ accepted: true }));

      const result = await withToolFileInteractionContext(
        {
          streamId,
          executionId,
          runtimeHost: explicit.host,
          tracker: {} as never,
        },
        () =>
          tool.call({
            execution_id: executionId,
            files: [{ path: 'output.tex', original: 'paper.tex' }],
          }),
      );

      expect(result.isError).toBeUndefined();
      expect(explicit.events).toContainEqual({
        event: 'workspaceFilesWritten',
        payload: { absolutePaths: [`${workspacePath}/paper.tex`] },
      });
      expect(fallback.events).toEqual([]);
    } finally {
      setDefaultAgentRuntimeHost(previousDefault);
    }
  });

  it('fails before workspace writes when the tool runtime host is missing', async () => {
    const tool = new AcceptRunFilesTool();
    let writes = 0;

    WorkspaceFS.write = async () => {
      writes++;
    };

    const result = await tool.call({
      execution_id: executionId,
      files: [{ path: 'output.tex', original: 'paper.tex' }],
    });

    expect(result.isError).toBe(true);
    expect(result.error).toContain('requires a tool runtime host');
    expect(writes).toBe(0);
  });
});
