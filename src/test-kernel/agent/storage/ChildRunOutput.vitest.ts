import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect } from 'vitest';

import { getRunRecords, resolveChildRunOutput } from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  aggregateId,
  RoundOutputSchema,
  type DeliveredResult,
  type RoundOutput,
  type RunId,
} from '@shared/schemas';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { fakePath } from '@test/support/FakePlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';

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

/** The child's declared files, as its `output.produced` row reports them. */
function workflowRounds(absolutePath: string): RoundOutput[] {
  return [
    RoundOutputSchema.parse({
      round: 1,
      rawOutput: null,
      outputs: [
        {
          source: 'draft',
          round: 1,
          location: {
            kind: 'runStorage',
            absolutePath,
            relativePath,
            runId: childRunId,
          },
          lineage: null,
          diff: null,
        },
      ],
    }),
  ];
}

const completedWorkflowResult: DeliveredResult = {
  producer: 'subagent',
  agentName: 'draft',
  wallTimeMs: 10,
  output: { category: 'workflow', outputs: [], compileFailures: [], diffs: [] },
};

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
      completedWorkflowResult,
    );
    // How the child ended is the `run.end` row's fact, and what it declared
    // is its `output.produced` row's, not the manifest's.
    yield* session.commit([
      {
        type: 'output.produced',
        aggregateId: aggregateId('run', childRunId),
        rounds: workflowRounds(absolutePath),
      },
      {
        type: 'run.end',
        aggregateId: aggregateId('run', childRunId),
        outcome: 'completed',
        output: { category: 'workflow' },
      },
    ]);
    yield* Effect.promise(() =>
      mkdir(path.join(storageRoot, `executions/${childRunId}/r1`), {
        recursive: true,
      }),
    );
    yield* Effect.promise(() => writeFile(absolutePath, 'draft'));
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
        yield* Effect.promise(() => writeFile(undeclaredPath, 'notes'));

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
      yield* Effect.promise(() => rm(absolutePath));

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
