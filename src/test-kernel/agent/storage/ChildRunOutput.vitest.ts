import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearStoreCache,
  getExecutionStore,
  resolveChildRunOutput,
  type ResultMeta,
} from '@agent/storage';
import type { ExecutionId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { StorageFS } from '@utils/files/storageFS';

const parentExecutionId = 'aaaaaa111111' as ExecutionId;
const childExecutionId = 'bbbbbb222222' as ExecutionId;
const otherParentExecutionId = 'cccccc333333' as ExecutionId;
const relativePath = 'r1/draft.tex';

setupPlatform({ storagePath: '/storage', workspacePath: '/workspace' });

function completedWorkflowResult(absolutePath: string): ResultMeta {
  return {
    producer: 'subagent',
    agentName: 'draft',
    wallTimeMs: 10,
    result: {
      category: 'workflow',
      outcome: 'completed',
      outputs: [
        {
          round: 1,
          relativePath,
          absolutePath,
          location: 'runStorage',
          originalPath: null,
          added: null,
          removed: null,
        },
      ],
      compileFailures: [],
      diffs: [],
      cost: 0,
    },
  };
}

async function persistCompletedChild(
  parentId: ExecutionId = parentExecutionId,
): Promise<string> {
  const absolutePath = StorageFS.fullPath(
    `executions/${childExecutionId}/${relativePath}`,
  );
  const store = getExecutionStore(childExecutionId);
  await store.writeMeta({
    schemaVersion: 1,
    timestamp: '2026-07-15T00:00:00.000Z',
    parentExecutionId: parentId,
    outcome: 'completed',
  });
  await store.writeResultMeta(completedWorkflowResult(absolutePath));
  await StorageFS.ensureDir(`executions/${childExecutionId}/r1`);
  await StorageFS.write(
    `executions/${childExecutionId}/${relativePath}`,
    'draft',
  );
  return absolutePath;
}

describe('resolveChildRunOutput', () => {
  beforeEach(() => clearStoreCache());
  afterEach(() => clearStoreCache());

  it('resolves a declared regular output of a completed direct child', async () => {
    const absolutePath = await persistCompletedChild();

    await expect(
      resolveChildRunOutput(parentExecutionId, absolutePath),
    ).resolves.toEqual({
      kind: 'runStorage',
      absolutePath,
      relativePath,
      executionId: childExecutionId,
    });
  });

  it('rejects output references from an unrelated execution tree', async () => {
    const absolutePath = await persistCompletedChild(otherParentExecutionId);

    await expect(
      resolveChildRunOutput(parentExecutionId, absolutePath),
    ).rejects.toThrow('is not a direct child');
  });

  it('rejects files that are present but absent from the result manifest', async () => {
    const absolutePath = await persistCompletedChild();
    const undeclaredPath = absolutePath.replace('draft.tex', 'notes.tex');
    await StorageFS.write(
      `executions/${childExecutionId}/r1/notes.tex`,
      'notes',
    );

    await expect(
      resolveChildRunOutput(parentExecutionId, undeclaredPath),
    ).rejects.toThrow('is not a declared output');
  });

  it('fails loudly when a declared output has disappeared', async () => {
    const absolutePath = await persistCompletedChild();
    await StorageFS.delete(`executions/${childExecutionId}/${relativePath}`);

    await expect(
      resolveChildRunOutput(parentExecutionId, absolutePath),
    ).rejects.toThrow('is missing');
  });

  it('rejects paths outside run storage', async () => {
    await expect(
      resolveChildRunOutput(parentExecutionId, '/workspace/draft.tex'),
    ).rejects.toThrow('not inside task-run storage');
  });
});
