import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, afterEach, describe, expect } from 'vitest';

import {
  clearStoreCache,
  getRunRecords,
  resolveChildRunOutput,
  type ResultMeta,
} from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  type StreamTabId,
  type RunId,
} from '@shared/schemas';
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

function persistCompletedChild(
  parentId: RunId = parentRunId,
): Effect.Effect<string, Error> {
  return Effect.gen(function* () {
    const absolutePath = StorageFS.fullPath(
      `executions/${childRunId}/${relativePath}`,
    );
    const parentStreamId = `stream-${parentId}` as StreamTabId;
    publishTestRunStart(session, parentStreamId, parentId);
    yield* Effect.promise(() => session.settlePublications());
    yield* session.commit([
      {
        type: 'run.start',
        aggregateId: aggregateId('stream', `stream-${childRunId}`),
        executionId: childRunId,
        parentStreamId,
        identity: { kind: 'agent', agent: 'draft' },
        category: 'workflow',
        isRemote: false,
        userFollowUpSupport: 'unsupported',
      },
    ]);
    yield* getRunRecords(session, childRunId).writeResultMeta(
      completedWorkflowResult(absolutePath),
    );
    yield* Effect.promise(() =>
      StorageFS.ensureDir(`executions/${childRunId}/r1`),
    );
    yield* Effect.promise(() =>
      StorageFS.write(
        `executions/${childRunId}/${relativePath}`,
        'draft',
      ),
    );
    return absolutePath;
  });
}

describe('resolveChildRunOutput', () => {
  afterEach(() => clearStoreCache());

  it.effect(
    'resolves a declared regular output of a completed direct child',
    () =>
      Effect.gen(function* () {
        const absolutePath = yield* persistCompletedChild();

        expect(
          yield* resolveChildRunOutput(
            parentRunId,
            absolutePath,
            session,
          ),
        ).toEqual({
          kind: 'runStorage',
          absolutePath,
          relativePath,
          executionId: childRunId,
        });
      }),
  );

  it.effect('rejects output references from an unrelated execution tree', () =>
    Effect.gen(function* () {
      const absolutePath = yield* persistCompletedChild(otherParentRunId);

      const failure = yield* Effect.flip(
        resolveChildRunOutput(parentRunId, absolutePath, session),
      );
      expect(failure.message).toContain('is not a direct child');
    }),
  );

  it.effect(
    'rejects files that are present but absent from the result manifest',
    () =>
      Effect.gen(function* () {
        const absolutePath = yield* persistCompletedChild();
        const undeclaredPath = absolutePath.replace('draft.tex', 'notes.tex');
        yield* Effect.promise(() =>
          StorageFS.write(
            `executions/${childRunId}/r1/notes.tex`,
            'notes',
          ),
        );

        const failure = yield* Effect.flip(
          resolveChildRunOutput(parentRunId, undeclaredPath, session),
        );
        expect(failure.message).toContain('is not a declared output');
      }),
  );

  it.effect('fails loudly when a declared output has disappeared', () =>
    Effect.gen(function* () {
      const absolutePath = yield* persistCompletedChild();
      yield* Effect.promise(() =>
        StorageFS.delete(`executions/${childRunId}/${relativePath}`),
      );

      const failure = yield* Effect.flip(
        resolveChildRunOutput(parentRunId, absolutePath, session),
      );
      expect(failure.message).toContain('is missing');
    }),
  );

  it.effect('rejects paths outside run storage', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        resolveChildRunOutput(
          parentRunId,
          '/workspace/draft.tex',
          session,
        ),
      );
      expect(failure.message).toContain('not inside task-run storage');
    }),
  );
});
