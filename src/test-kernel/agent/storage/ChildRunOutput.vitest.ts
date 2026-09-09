import { Effect } from 'effect';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import {
  clearStoreCache,
  getExecutionRecords,
  resolveChildRunOutput,
  type ResultMeta,
} from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  type StreamTabId,
  type ExecutionId,
} from '@shared/schemas';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { StorageFS } from '@utils/files/storageFS';

const parentExecutionId = 'aaaaaa111111' as ExecutionId;
const childExecutionId = 'bbbbbb222222' as ExecutionId;
const otherParentExecutionId = 'cccccc333333' as ExecutionId;
const relativePath = 'r1/draft.tex';

setupPlatform({ storagePath: '/storage', workspacePath: '/workspace' });
let session: SessionHandle;
beforeEach(() => {
  session = createProcessSession();
});

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
  const parentStreamId = `stream-${parentId}` as StreamTabId;
  publishTestRunStart(session, parentStreamId, parentId);
  await session.settlePublications();
  await Effect.runPromise(
    session.commit([
      {
        type: 'run.start',
        aggregateId: aggregateId('stream', `stream-${childExecutionId}`),
        executionId: childExecutionId,
        parentStreamId,
        identity: { kind: 'agent', agent: 'draft' },
        category: 'workflow',
        isRemote: false,
        userFollowUpSupport: 'unsupported',
      },
    ]),
  );
  await Effect.runPromise(
    getExecutionRecords(session, childExecutionId).writeResultMeta(
      completedWorkflowResult(absolutePath),
    ),
  );
  await StorageFS.ensureDir(`executions/${childExecutionId}/r1`);
  await StorageFS.write(
    `executions/${childExecutionId}/${relativePath}`,
    'draft',
  );
  return absolutePath;
}

describe('resolveChildRunOutput', () => {
  afterEach(() => clearStoreCache());

  it('resolves a declared regular output of a completed direct child', async () => {
    const absolutePath = await persistCompletedChild();

    await expect(
      Effect.runPromise(
        resolveChildRunOutput(parentExecutionId, absolutePath, session),
      ),
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
      Effect.runPromise(
        resolveChildRunOutput(parentExecutionId, absolutePath, session),
      ),
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
      Effect.runPromise(
        resolveChildRunOutput(parentExecutionId, undeclaredPath, session),
      ),
    ).rejects.toThrow('is not a declared output');
  });

  it('fails loudly when a declared output has disappeared', async () => {
    const absolutePath = await persistCompletedChild();
    await StorageFS.delete(`executions/${childExecutionId}/${relativePath}`);

    await expect(
      Effect.runPromise(
        resolveChildRunOutput(parentExecutionId, absolutePath, session),
      ),
    ).rejects.toThrow('is missing');
  });

  it('rejects paths outside run storage', async () => {
    await expect(
      Effect.runPromise(
        resolveChildRunOutput(
          parentExecutionId,
          '/workspace/draft.tex',
          session,
        ),
      ),
    ).rejects.toThrow('not inside task-run storage');
  });
});
