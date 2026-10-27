import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';

import { describe, expect } from 'vitest';
import { registryOf } from '@agent/runtime/runRegistry';

import {
  RUN_OUTCOME,
  qualifyAggregateId,
  RunIdSchema,
  type RunId,
} from '@shared/schemas';
import { closeSessionOf } from '@test/support/sessionEnd';
import { createFakeWorkspaceRoots, fakePath } from '@test/support/FakePlatform';
import { testRunHandle } from '@test/support/runHandleFixtures';
import {
  createTestSession,
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';

describe('session isolation', () => {
  it.effect(
    'the host-exit drain settles each session under its own root, outside any scope',
    () =>
      Effect.gen(function* () {
        // Persistent stores, so each root's rows outlive its session's close
        // and are read back from the root they landed in.
        const rootsA = createFakeWorkspaceRoots({
          workspacePath: fakePath('papers/a'),
          storagePath: fakePath('storage/a'),
        });
        const rootsB = createFakeWorkspaceRoots({
          workspacePath: fakePath('papers/b'),
          storagePath: fakePath('storage/b'),
        });
        const sessionA = yield* createTestSession({
          roots: rootsA,
          persistent: true,
        });
        yield* Effect.addFinalizer(() => closeSessionOf(sessionA));
        const sessionB = yield* createTestSession({
          roots: rootsB,
          persistent: true,
        });
        yield* Effect.addFinalizer(() => closeSessionOf(sessionB));
        const live = [
          [sessionA, 'a0da01' as RunId],
          [sessionB, 'b0db01' as RunId],
        ] as const;
        for (const [session, runId] of live) {
          publishTestRunStart(session, runId);
          publishTestRows(session, [
            {
              type: 'stage.start',
              aggregateId: qualifyAggregateId('run', runId),
              id: `stage:${runId}`,
              label: 'Running stage',
            },
          ]);
          yield* session.log.settled;
          registryOf(session.runs).track(
            testRunHandle({ runId, agent: 'assistant' }),
          );
        }
        // Each session claims runs in its own root: paper B never holds
        // paper A's run.
        expect(yield* sessionB.log.owns('a0da01' as RunId)).toBe(false);
        yield* Effect.all(
          [closeSessionOf(sessionA), closeSessionOf(sessionB)],
          {
            concurrency: 'unbounded',
          },
        );
        // Each run's end landed in its own root's store, and only there.
        for (const [roots, own, other] of [
          [rootsA, 'a0da01', 'b0db01'],
          [rootsB, 'b0db01', 'a0da01'],
        ] as const) {
          const reopened = yield* createTestSession({
            roots,
            persistent: true,
          });
          const ends = (runId: string) =>
            reopened.log.rows(
              qualifyAggregateId(
                'run',
                Schema.decodeUnknownSync(RunIdSchema)(runId),
              ),
              ['run.end'],
            );
          expect(yield* ends(own)).toMatchObject([
            { outcome: RUN_OUTCOME.CANCELLED },
          ]);
          expect(yield* ends(other)).toEqual([]);
          yield* closeSessionOf(reopened);
        }
      }),
  );
});
