import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect } from 'vitest';

import { getRunRecords, resolveChildRunOutput } from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  type ResultMeta,
  type RunEndOutput,
  type RunId,
} from '@shared/schemas';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { fakePath } from '@test/support/FakePlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { AbsoluteFS } from '@utils/files/absoluteFS';

const parentRunId = 'aaaaaa111111' as RunId;
const childRunId = 'bbbbbb222222' as RunId;
const otherParentRunId = 'cccccc333333' as RunId;
const relativePath = 'r1/draft.tex';

setupPlatform({
  storagePath: fakePath('storage'),
  workspacePath: fakePath('workspace'),
});
let session: SessionHandle;
beforeEach(async () => {
  session = await Effect.runPromise(createProcessSession());
});

function workflowOutput(absolutePath: string): RunEndOutput {
  return {
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
  };
}

function completedWorkflowResult(absolutePath: string): ResultMeta {
  return {
    producer: 'subagent',
    agentName: 'draft',
    wallTimeMs: 10,
    output: workflowOutput(absolutePath),
  };
}

const persistCompletedChild = (parentId: RunId = parentRunId) =>
  Effect.gen(function* () {
    const storageRoot = session.roots.storage;
    const absolutePath = path.join(
      storageRoot,
      `executions/${childRunId}/${relativePath}`,
    );
    publishTestRunStart(session, parentId);
    yield* session.settlePublications();
    yield* session.commit([
      {
        type: 'run.start',
        aggregateId: aggregateId('run', childRunId),
        identity: { kind: 'agent', agent: 'draft' },
        category: 'workflow',
        isRemote: false,
        userFollowUpSupport: 'unsupported',
        parent: { id: parentId },
      },
    ]);
    yield* getRunRecords(session, childRunId).writeResultMeta(
      completedWorkflowResult(absolutePath),
    );
    // How the child ended is the `run.end` row's fact, not the manifest's.
    yield* session.commit([
      {
        type: 'run.end',
        aggregateId: aggregateId('run', childRunId),
        outcome: 'completed',
        output: workflowOutput(absolutePath),
      },
    ]);
    yield* Effect.promise(() =>
      AbsoluteFS.ensureDir(
        path.join(storageRoot, `executions/${childRunId}/r1`),
      ),
    );
    yield* Effect.promise(() => AbsoluteFS.write(absolutePath, 'draft'));
    return absolutePath;
  });

describe('resolveChildRunOutput', () => {
  it.effect(
    'resolves a declared regular output of a completed direct child',
    () =>
      Effect.gen(function* () {
        const absolutePath = yield* persistCompletedChild();

        expect(
          yield* resolveChildRunOutput(parentRunId, absolutePath, session).pipe(
            Effect.provide(nodePlatformLayer),
          ),
        ).toEqual({
          kind: 'runStorage',
          absolutePath,
          relativePath,
          runId: childRunId,
        });
      }),
  );

  it.effect('rejects output references from an unrelated run tree', () =>
    Effect.gen(function* () {
      const absolutePath = yield* persistCompletedChild(otherParentRunId);

      const error = yield* Effect.flip(
        resolveChildRunOutput(parentRunId, absolutePath, session).pipe(
          Effect.provide(nodePlatformLayer),
        ),
      );
      expect(error.message).toContain('is not a direct child');
    }),
  );

  it.effect(
    'rejects files that are present but absent from the result manifest',
    () =>
      Effect.gen(function* () {
        const absolutePath = yield* persistCompletedChild();
        const undeclaredPath = absolutePath.replace('draft.tex', 'notes.tex');
        yield* Effect.promise(() => AbsoluteFS.write(undeclaredPath, 'notes'));

        const error = yield* Effect.flip(
          resolveChildRunOutput(parentRunId, undeclaredPath, session).pipe(
            Effect.provide(nodePlatformLayer),
          ),
        );
        expect(error.message).toContain('is not a declared output');
      }),
  );

  it.effect('fails loudly when a declared output has disappeared', () =>
    Effect.gen(function* () {
      const absolutePath = yield* persistCompletedChild();
      yield* Effect.promise(() => AbsoluteFS.delete(absolutePath));

      const error = yield* Effect.flip(
        resolveChildRunOutput(parentRunId, absolutePath, session).pipe(
          Effect.provide(nodePlatformLayer),
        ),
      );
      expect(error.message).toContain('is missing');
    }),
  );

  it.effect('rejects paths outside run storage', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        resolveChildRunOutput(
          parentRunId,
          fakePath('workspace/draft.tex'),
          session,
        ).pipe(Effect.provide(nodePlatformLayer)),
      );
      expect(error.message).toContain('not inside run storage');
    }),
  );
});
