// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports
import {
  getDefaultAgentRuntimeHost,
  setDefaultAgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { withToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { AcceptRunFilesTool } from '@tools/AcceptRunFilesTool';
import {
  cleanupAllApprovals,
  setToolEditApprovalHandler,
} from '@tools/approval';
import { AbsoluteFS, flexibleFS, StorageFS, WorkspaceFS } from '@utils/files';
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
  let originalAbsoluteIsFile: typeof AbsoluteFS.isFile;
  let originalAbsoluteRead: typeof AbsoluteFS.read;
  let originalFlexibleRead: typeof flexibleFS.read;

  beforeEach(() => {
    originalStorageExists = StorageFS.exists;
    originalStorageFullPath = StorageFS.fullPath;
    originalWorkspaceLocatePath = WorkspaceFS.locatePath;
    originalWorkspaceExists = WorkspaceFS.exists;
    originalWorkspaceRead = WorkspaceFS.read;
    originalWorkspaceWrite = WorkspaceFS.write;
    originalWorkspaceDelete = WorkspaceFS.delete;
    originalAbsoluteIsFile = AbsoluteFS.isFile;
    originalAbsoluteRead = AbsoluteFS.read;
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
    AbsoluteFS.isFile = originalAbsoluteIsFile;
    AbsoluteFS.read = originalAbsoluteRead;
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

      const result = await withRunContext(
        createRunContext({
          runtimeHost: explicit.host,
          streamId,
          executionId,
        }),
        () =>
          withToolFileInteractionContext({ tracker: {} as never }, () =>
            tool.call({
              execution_id: executionId,
              files: [{ path: 'output.tex', original: 'paper.tex' }],
            }),
          ),
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

  it('uses the pre-run snapshot for same-path workspace outputs', async () => {
    const previousDefault = getDefaultAgentRuntimeHost();
    const fallback = createRecordingHost();
    const tool = new AcceptRunFilesTool();
    let approvalOriginal = '';
    let approvalProposed = '';
    let writes = 0;

    try {
      setDefaultAgentRuntimeHost(fallback.host);
      StorageFS.exists = async (target) =>
        target === `executions/${executionId}`;
      StorageFS.fullPath = (target) => `${storagePath}/${target}`;
      WorkspaceFS.locatePath = (target) => ({
        kind: 'workspace',
        absolutePath: `${workspacePath}/${target}`,
        relativePath: target,
      });
      WorkspaceFS.exists = async () => true;
      WorkspaceFS.read = async () => 'new content';
      WorkspaceFS.write = async () => {
        writes++;
      };
      WorkspaceFS.delete = async () => undefined;
      AbsoluteFS.isFile = async (target) =>
        target ===
        `${storagePath}/executions/${executionId}/original/draft.tex`;
      AbsoluteFS.read = async () => 'old content';
      flexibleFS.read = async () => 'new content';
      setToolEditApprovalHandler(async (request) => {
        approvalOriginal = request.originalContent;
        approvalProposed = request.proposedContent;
        return { accepted: true };
      });

      const result = await withRunContext(
        createRunContext({
          runtimeHost: fallback.host,
          streamId,
          executionId,
        }),
        () =>
          withToolFileInteractionContext({ tracker: {} as never }, () =>
            tool.call({
              execution_id: executionId,
              files: [{ path: 'draft.tex', original: 'draft.tex' }],
            }),
          ),
      );

      expect(result.isError).toBeUndefined();
      expect(approvalOriginal).toBe('old content');
      expect(approvalProposed).toBe('new content');
      expect(result.edits?.[0]?.lineChanges).toEqual({
        added: 1,
        removed: 1,
      });
      expect(writes).toBe(0);
    } finally {
      setDefaultAgentRuntimeHost(previousDefault);
    }
  });

  it('reports unchanged same-path fallbacks without approval', async () => {
    const previousDefault = getDefaultAgentRuntimeHost();
    const fallback = createRecordingHost();
    const tool = new AcceptRunFilesTool();
    let approvals = 0;
    let writes = 0;

    try {
      setDefaultAgentRuntimeHost(fallback.host);
      StorageFS.exists = async (target) =>
        target === `executions/${executionId}`;
      StorageFS.fullPath = (target) => `${storagePath}/${target}`;
      WorkspaceFS.locatePath = (target) => ({
        kind: 'workspace',
        absolutePath: `${workspacePath}/${target}`,
        relativePath: target,
      });
      WorkspaceFS.exists = async () => true;
      WorkspaceFS.read = async () => 'same content';
      WorkspaceFS.write = async () => {
        writes++;
      };
      WorkspaceFS.delete = async () => undefined;
      AbsoluteFS.isFile = async () => false;
      flexibleFS.read = async () => 'same content';
      setToolEditApprovalHandler(async () => {
        approvals++;
        return { accepted: true };
      });

      const result = await withRunContext(
        createRunContext({
          runtimeHost: fallback.host,
          streamId,
          executionId,
        }),
        () =>
          withToolFileInteractionContext({ tracker: {} as never }, () =>
            tool.call({
              execution_id: executionId,
              files: [{ path: 'draft.tex', original: 'draft.tex' }],
            }),
          ),
      );

      expect(result.isError).toBeUndefined();
      expect(result.output).toContain('No changes to accept');
      expect(result.output).toContain('unchanged: draft.tex');
      expect(approvals).toBe(0);
      expect(writes).toBe(0);
      expect(fallback.events).toEqual([]);
    } finally {
      setDefaultAgentRuntimeHost(previousDefault);
    }
  });
});
