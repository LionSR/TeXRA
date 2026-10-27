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

  /**
   * #12433, and the reason #12421 retired the carrier. This contract is the
   * one the desktop needs — two open projects, each its own session, its own
   * storage root — and an async-local frame could never meet it: a run fiber
   * resuming after a contended commit resumed outside the frame and read the
   * PROCESS roots. Roots arrive as data now, so the fiber's answer cannot
   * depend on which turn it resumes in. The case was `.fails` until the
   * carrier went; it is green from here.
   */
  it.effect(
    'a run fiber keeps its session roots across a contended publisher commit',
    () =>
      Effect.gen(function* () {
        const project = createFakeWorkspaceRoots({
          workspacePath: fakePath('papers/contended'),
          storagePath: fakePath('storage/contended'),
        });
        const session = yield* createTestSession({ roots: project });
        yield* Effect.addFinalizer(() => closeSessionOf(session));
        // Job 1: enqueued on the session's one publisher from the process
        // context, the shape the desktop has.
        publishTestRunStart(session, 'c0c001' as RunId);
        // Job 2: the run fiber's own awaited commit, enqueued in the same
        // synchronous turn, so the publisher is already contended when it runs.
        yield* session.log.transact([
          {
            type: 'run.start',
            aggregateId: qualifyAggregateId('run', 'c0c002' as RunId),
            identity: { kind: 'agent', agent: 'chat' },
            userFollowUpSupport: 'unsupported',
            parent: null,
            provenance: null,
          },
        ]);
        expect(session.roots.workspace).toBe(fakePath('papers/contended'));
        expect(session.roots.storage).toBe(fakePath('storage/contended'));
      }),
  );
});
