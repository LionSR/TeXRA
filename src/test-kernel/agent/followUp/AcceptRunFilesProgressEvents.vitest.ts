// Test composition imports

// Local imports
import '@test/support/defaultSessionTestSetup';

// Node imports
import * as path from 'node:path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { withToolFileInteractionContext } from '@agent/followUp/ToolFileInteractionContext';
import { appSignals } from '@eventBus/AppSignals';
import { FileType, type FileStat } from '@platform/interfaces';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import {
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval';
import { AcceptRunFilesTool } from '@tools/AcceptRunFilesTool';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { StorageFS } from '@utils/files/storageFS';
import { WorkspaceFS } from '@utils/files/workspaceFS';

// Local file imports
import { createRecordingHost } from '../progressTestUtils';

let testApprovalHandler:
  | ((request: ToolEditApprovalRequest) => Promise<ToolEditApprovalResult>)
  | undefined;
let detachHostInteractions = (): void => {};

const executionId = 'abcdef' as ExecutionId;
const streamId = 'stream:accept-run-files' as StreamTabId;
const workspacePath = '/workspace';
const storagePath = '/storage';

function installTestPlatform(): Promise<void> {
  return installPlatform({
    workspacePath,
    storagePath,
    globalStoragePath: '/global/.texra/storage',
  }).then(() => {
    detachHostInteractions();
    detachHostInteractions = defaultSession().useHostInteractions({
      requestToolEditApproval: (request) => {
        const handler = testApprovalHandler;
        if (!handler) {
          throw new Error('No test handler. Set `testApprovalHandler`.');
        }
        return handler(request);
      },
      cancel: () => undefined,
    });
  });
}

function runStorageStat(type: number): FileStat {
  return { type, ctime: 0, mtime: 0, size: 1 };
}

function setRunStorageEntries(
  entries: Readonly<Record<string, number>> = {},
): void {
  const types = new Map<string, number>([
    [`executions/${executionId}`, FileType.Directory],
    ...Object.entries(entries),
  ]);
  for (const entry of Object.keys(entries)) {
    let parent = path.posix.dirname(entry);
    while (parent !== '.' && parent !== `executions/${executionId}`) {
      types.set(parent, FileType.Directory);
      parent = path.posix.dirname(parent);
    }
  }
  vi.spyOn(StorageFS, 'exists').mockImplementation(async (target) =>
    types.has(target),
  );
  vi.spyOn(StorageFS, 'stat').mockImplementation(async (target) => {
    const type = types.get(target);
    if (type !== undefined) return runStorageStat(type);
    throw Object.assign(new Error(`Missing: ${target}`), { code: 'ENOENT' });
  });
}

/** Stubs the workspace side of an accept and returns the write spy. */
function stubWorkspaceFiles(exists: boolean, content: string) {
  vi.spyOn(WorkspaceFS, 'exists').mockResolvedValue(exists);
  vi.spyOn(WorkspaceFS, 'read').mockResolvedValue(content);
  vi.spyOn(WorkspaceFS, 'delete').mockResolvedValue(undefined);
  return vi.spyOn(WorkspaceFS, 'write').mockResolvedValue(undefined);
}

function runAccept(
  tool: AcceptRunFilesTool,
  files: { path: string; original: string }[],
  tracker = new FileInteractionState(),
) {
  return withRunContext(createRunContext({ streamId, executionId }), () =>
    withToolFileInteractionContext({ tracker }, () =>
      tool.call({ execution_id: executionId, files }),
    ),
  );
}

async function acceptAll(
  request: ToolEditApprovalRequest,
): Promise<ToolEditApprovalResult> {
  return { action: 'apply', appliedContent: request.proposedContent };
}

/** Collects workspaceFilesWritten payloads until disposed. */
function recordWrittenFiles(): { written: string[][]; dispose: () => void } {
  const written: string[][] = [];
  const dispose = appSignals.on(
    'workspaceFilesWritten',
    ({ absolutePaths }) => {
      written.push(absolutePaths);
    },
  );
  return { written, dispose };
}

describe('accept_run_files progress events', () => {
  beforeEach(async () => {
    testApprovalHandler = undefined;
    await installTestPlatform();
    defaultSession().approvals.clearAll();
    defaultSession().interactions.cancel({ cause: 'All approvals cleared.' });
    // Shared by every test below that stubs the execution/workspace paths;
    // the test that doesn't need it (missing runtime host) fails before
    // reaching either function.
    vi.spyOn(StorageFS, 'fullPath').mockImplementation(
      (target) => `${storagePath}/${target}`,
    );
    vi.spyOn(WorkspaceFS, 'locatePath').mockImplementation((target) => ({
      kind: 'workspace',
      absolutePath: `${workspacePath}/${target}`,
      relativePath: target,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    testApprovalHandler = undefined;
    detachHostInteractions();
    detachHostInteractions = () => {};
    defaultSession().approvals.clearAll();
    defaultSession().interactions.cancel({ cause: 'All approvals cleared.' });
  });

  it('publishes accepted workspace files through app signals', async () => {
    const explicit = createRecordingHost();
    const tool = new AcceptRunFilesTool();
    const tracker = new FileInteractionState();
    const { written, dispose } = recordWrittenFiles();

    setRunStorageEntries({
      [`executions/${executionId}/output.tex`]: FileType.File,
    });
    stubWorkspaceFiles(false, '');
    vi.spyOn(AbsoluteFS, 'read').mockResolvedValue('accepted content');
    testApprovalHandler = acceptAll;

    const result = await runAccept(
      tool,
      [{ path: 'output.tex', original: 'paper.tex' }],
      tracker,
    );

    expect(result.status).toBe('executed');
    expect(explicit.events).toEqual([]);
    expect(written).toEqual([[`${workspacePath}/paper.tex`]]);
    expect(tracker.hasRead('paper.tex')).toBe(true);
    dispose();
  });

  it('reports an all-file user rejection without calling it a cancellation', async () => {
    const tool = new AcceptRunFilesTool();

    setRunStorageEntries({
      [`executions/${executionId}/output.tex`]: FileType.File,
    });
    stubWorkspaceFiles(false, '');
    vi.spyOn(AbsoluteFS, 'read').mockResolvedValue('proposed content');
    testApprovalHandler = async () => ({
      action: 'reject',
      feedback: 'keep the original normalization',
    });

    const result = await runAccept(tool, [
      { path: 'output.tex', original: 'paper.tex' },
    ]);

    expect(result.status).toBe('error');
    expect(result.summary).toBe(
      'User rejected accept_run_files for paper.tex.',
    );
    expect(result.userInstruction).toBe('keep the original normalization');
    expect(result.error).not.toContain('cancelled');
  });

  it('preserves a cause-free cancellation while aggregating rejections', async () => {
    const tool = new AcceptRunFilesTool();

    setRunStorageEntries({
      [`executions/${executionId}/output.tex`]: FileType.File,
    });
    stubWorkspaceFiles(false, '');
    vi.spyOn(AbsoluteFS, 'read').mockResolvedValue('proposed content');
    testApprovalHandler = async () => ({ action: 'reject', cause: undefined });

    const result = await runAccept(tool, [
      { path: 'output.tex', original: 'paper.tex' },
    ]);

    expect(result.summary).toBe(
      'Tool edit approval cancelled: accept_run_files for paper.tex.',
    );
    expect(result.userInstruction).toBeUndefined();
  });

  it('preserves mixed policy-denial and cancellation details', async () => {
    const tool = new AcceptRunFilesTool();

    setRunStorageEntries({
      [`executions/${executionId}/first.tex`]: FileType.File,
      [`executions/${executionId}/second.tex`]: FileType.File,
    });
    stubWorkspaceFiles(false, '');
    vi.spyOn(AbsoluteFS, 'read').mockResolvedValue('proposed content');
    testApprovalHandler = async (request) =>
      request.path === 'first.tex'
        ? { action: 'reject', reason: 'Denied by approval policy.' }
        : { action: 'reject', cause: 'Session disposed.' };

    const result = await runAccept(tool, [
      { path: 'first.tex', original: 'first.tex' },
      { path: 'second.tex', original: 'second.tex' },
    ]);

    expect(result.status).toBe('error');
    expect(result.summary).toBe(
      'Tool edit approval cancelled: accept_run_files for multiple files.',
    );
    expect(result.error).toContain('Denied by approval policy.');
    expect(result.error).toContain('Session disposed.');
    expect(result.userInstruction).toBeUndefined();
  });

  it('does not require a runtime host to publish accepted workspace files', async () => {
    const tool = new AcceptRunFilesTool();
    const { written, dispose } = recordWrittenFiles();

    setRunStorageEntries({
      [`executions/${executionId}/output.tex`]: FileType.File,
    });
    const write = stubWorkspaceFiles(false, '');
    vi.spyOn(AbsoluteFS, 'read').mockResolvedValue('accepted content');
    testApprovalHandler = acceptAll;

    const result = await tool.call({
      execution_id: executionId,
      files: [{ path: 'output.tex', original: 'paper.tex' }],
    });

    expect(result.status).toBe('executed');
    expect(write).toHaveBeenCalledOnce();
    expect(written).toEqual([[`${workspacePath}/paper.tex`]]);
    dispose();
  });

  it('uses the pre-run snapshot for same-path workspace outputs', async () => {
    const tool = new AcceptRunFilesTool();
    let approvalOriginal = '';
    let approvalProposed = '';
    const snapshotPath = `${storagePath}/executions/${executionId}/original/draft.tex`;

    setRunStorageEntries();
    const write = stubWorkspaceFiles(true, 'new content');
    vi.spyOn(AbsoluteFS, 'isFile').mockImplementation(
      async (target) => target === snapshotPath,
    );
    vi.spyOn(AbsoluteFS, 'read').mockImplementation(async (target) =>
      target === snapshotPath ? 'old content' : 'new content',
    );
    testApprovalHandler = async (request) => {
      approvalOriginal = request.originalContent;
      approvalProposed = request.proposedContent;
      return { action: 'apply', appliedContent: request.proposedContent };
    };

    const result = await runAccept(tool, [
      { path: 'draft.tex', original: 'draft.tex' },
    ]);

    expect(result.status).toBe('executed');
    expect(approvalOriginal).toBe('old content');
    expect(approvalProposed).toBe('new content');
    expect(result.edits?.[0]?.lineChanges).toEqual({
      added: 1,
      removed: 1,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('reports unchanged same-path fallbacks without approval', async () => {
    const explicit = createRecordingHost();
    const tool = new AcceptRunFilesTool();
    let approvals = 0;

    setRunStorageEntries();
    const write = stubWorkspaceFiles(true, 'same content');
    vi.spyOn(AbsoluteFS, 'isFile').mockResolvedValue(false);
    vi.spyOn(AbsoluteFS, 'read').mockResolvedValue('same content');
    testApprovalHandler = async (request) => {
      approvals++;
      return { action: 'apply', appliedContent: request.proposedContent };
    };

    const result = await runAccept(tool, [
      { path: 'draft.tex', original: 'draft.tex' },
    ]);

    expect(result.status).toBe('executed');
    expect(result.output).toContain('No changes to accept');
    expect(result.output).toContain('unchanged: draft.tex');
    expect(approvals).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(explicit.events).toEqual([]);
  });

  it('refuses symlinked run-storage entries so unemitted files cannot be accepted', async () => {
    const explicit = createRecordingHost();
    const tool = new AcceptRunFilesTool();
    let approvals = 0;

    setRunStorageEntries({
      [`executions/${executionId}/r1/Draft/appendices.tex`]:
        FileType.SymbolicLink | FileType.File,
    });
    const write = stubWorkspaceFiles(true, '');
    testApprovalHandler = async (request) => {
      approvals++;
      return { action: 'apply', appliedContent: request.proposedContent };
    };

    const result = await runAccept(tool, [
      { path: 'r1/Draft/appendices.tex', original: 'Draft/appendices.tex' },
    ]);

    expect(result.status).toBe('error');
    expect(result.error).toContain('symlink');
    expect(result.error).toContain('did not emit');
    expect(approvals).toBe(0);
    expect(write).not.toHaveBeenCalled();
    expect(explicit.events).toEqual([]);
  });
});
