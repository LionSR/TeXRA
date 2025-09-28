// Standard library imports
import { strict as assert } from 'assert';
import * as path from 'path';

// Local imports - agent utils
import { writePromptToXml } from '@agent/utils/promptUtils';

// Local imports - types
import type { ExecutionId } from '@agent/types/IdentifierTypes';

// Local imports - utilities
import { StorageFS, TASK_RUNS_DIR, WorkspaceFS } from '@utils/files';

describe('promptUtils.writePromptToXml', () => {
  const originalStorageEnsureDir = StorageFS.ensureDir;
  const originalStorageWrite = StorageFS.write;
  const originalStorageFullPath = StorageFS.fullPath;
  const originalWorkspaceWrite = WorkspaceFS.write;

  afterEach(() => {
    StorageFS.ensureDir = originalStorageEnsureDir;
    StorageFS.write = originalStorageWrite;
    StorageFS.fullPath = originalStorageFullPath;
    WorkspaceFS.write = originalWorkspaceWrite;
  });

  it('stores prompts under task run storage when execution id is provided', async () => {
    const ensureCalls: string[] = [];
    let writePath: string | undefined;
    let workspaceWriteCalled = false;
    const storageRoot = path.join('/storage-root');
    const executionId = 'exec-1234' as ExecutionId;

    StorageFS.ensureDir = (async (relativePath: string) => {
      ensureCalls.push(relativePath);
    }) as typeof StorageFS.ensureDir;

    StorageFS.write = (async (
      relativePath: string,
      _content: string | Uint8Array,
    ) => {
      writePath = relativePath;
    }) as typeof StorageFS.write;

    StorageFS.fullPath = ((relativePath: string) =>
      path.join(storageRoot, relativePath)) as typeof StorageFS.fullPath;

    WorkspaceFS.write = (async () => {
      workspaceWriteCalled = true;
    }) as typeof WorkspaceFS.write;

    const result = await writePromptToXml(
      'system prompt',
      'user prefix',
      'user request',
      '/workspace/report.tex',
      'reflect_agent',
      executionId,
    );

    const expectedRelative = path.join(
      TASK_RUNS_DIR,
      executionId,
      'report_reflect_input.xml',
    );

    assert.equal(writePath, expectedRelative);
    assert.deepEqual(ensureCalls, [TASK_RUNS_DIR, path.join(TASK_RUNS_DIR, executionId)]);
    assert.equal(result, path.join(storageRoot, expectedRelative));
    assert.equal(workspaceWriteCalled, false);
  });
});
