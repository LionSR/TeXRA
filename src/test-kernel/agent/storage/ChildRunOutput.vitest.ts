import { Effect } from 'effect';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import {
  clearStoreCache,
  getRunRecords,
  resolveChildRunOutput,
  type ResultMeta,
} from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { aggregateId, type RunId } from '@shared/schemas';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { StorageFS } from '@utils/files/storageFS';

const parentRunId = 'aaaaaa111111' as RunId;
const childRunId = 'bbbbbb222222' as RunId;
const otherParentRunId = 'cccccc333333' as RunId;
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
      outcome: 'completed',
      output: {
        category: 'workflow',
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
      },
    },
  };
}

async function persistCompletedChild(
  parentId: RunId = parentRunId,
): Promise<string> {
  const absolutePath = StorageFS.fullPath(
    `executions/${childRunId}/${relativePath}`,
  );
  publishTestRunStart(session, parentId);
  await session.settlePublications();
  await Effect.runPromise(
    session.commit([
      {
        type: 'run.start',
        aggregateId: aggregateId('run', childRunId),
        identity: { kind: 'agent', agent: 'draft' },
        category: 'workflow',
        isRemote: false,
        userFollowUpSupport: 'unsupported',
        parent: { id: parentId },
      },
    ]),
  );
  await Effect.runPromise(
    getRunRecords(session, childRunId).writeResultMeta(
      completedWorkflowResult(absolutePath),
    ),
  );
  await StorageFS.ensureDir(`executions/${childRunId}/r1`);
  await StorageFS.write(`executions/${childRunId}/${relativePath}`, 'draft');
  return absolutePath;
}

describe('resolveChildRunOutput', () => {
  afterEach(() => clearStoreCache());

  it('resolves a declared regular output of a completed direct child', async () => {
    const absolutePath = await persistCompletedChild();

    await expect(
      Effect.runPromise(
        resolveChildRunOutput(parentRunId, absolutePath, session),
      ),
    ).resolves.toEqual({
      kind: 'runStorage',
      absolutePath,
      relativePath,
      runId: childRunId,
    });
  });

  it('rejects output references from an unrelated run tree', async () => {
    const absolutePath = await persistCompletedChild(otherParentRunId);

    await expect(
      Effect.runPromise(
        resolveChildRunOutput(parentRunId, absolutePath, session),
      ),
    ).rejects.toThrow('is not a direct child');
  });

  it('rejects files that are present but absent from the result manifest', async () => {
    const absolutePath = await persistCompletedChild();
    const undeclaredPath = absolutePath.replace('draft.tex', 'notes.tex');
    await StorageFS.write(`executions/${childRunId}/r1/notes.tex`, 'notes');

    await expect(
      Effect.runPromise(
        resolveChildRunOutput(parentRunId, undeclaredPath, session),
      ),
    ).rejects.toThrow('is not a declared output');
  });

  it('fails loudly when a declared output has disappeared', async () => {
    const absolutePath = await persistCompletedChild();
    await StorageFS.delete(`executions/${childRunId}/${relativePath}`);

    await expect(
      Effect.runPromise(
        resolveChildRunOutput(parentRunId, absolutePath, session),
      ),
    ).rejects.toThrow('is missing');
  });

  it('rejects paths outside run storage', async () => {
    await expect(
      Effect.runPromise(
        resolveChildRunOutput(parentRunId, '/workspace/draft.tex', session),
      ),
    ).rejects.toThrow('not inside task-run storage');
  });
});
