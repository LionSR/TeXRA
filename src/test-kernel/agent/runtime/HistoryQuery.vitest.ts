import '@test/support/sessionGraphTestSetup';

import { setTimeout as delay } from 'node:timers/promises';

import { it } from '@effect/vitest';
import { Effect, Fiber, Stream, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect } from 'vitest';

import { HistoryQuery } from '@agent/runtime/historyQuery/HistoryQuery';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import { closeSessionOf } from '@test/support/sessionEnd';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';

/**
 * The history query store, over a real session. Failure modes, written
 * before the store:
 *
 * 1. A vocabulary change leaves a view that no longer compiles.
 * 2. A resumed run shows its previous lifecycle's outcome.
 * 3. A detached child still appears under its former parent.
 * 4. A runaway statement holds the store instead of stopping at its
 *    deadline, or the store stays dead after it.
 * 5. A run history row, a private record, or the session database's own tables
 *    are reachable from a query.
 * 6. A statement writes to the store or runs a second statement.
 * 7. `runs` comes from a view that lags the rows fed into `events`.
 */

const withSession = <A, E>(
  body: (session: SessionHandle) => Effect.Effect<A, E>,
) => Effect.acquireUseRelease(createTestSession(), body, closeSessionOf);

const query = (session: SessionHandle, sql: string, params: string[] = []) =>
  Effect.gen(function* () {
    yield* session.log.settled.pipe(Effect.orDie);
    return yield* session.history.query(sql, params);
  });

describe('HistoryQuery', () => {
  it.live(
    'stops a runaway statement at its deadline and serves the next query',
    () =>
      withSession((session) =>
        Effect.gen(function* () {
          publishTestRunStart(session);
          // The store is open and fed, so the runaway's only wait is its
          // deadline, which the test clock steps through.
          yield* query(session, 'SELECT count(*) FROM runs');
          const runaway = yield* Effect.gen(function* () {
            const stopped = yield* query(
              session,
              'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n',
            ).pipe(Effect.flip, Effect.forkChild);
            const stepping = yield* TestClock.adjust('1 second').pipe(
              Effect.andThen(Effect.promise(() => delay(20))),
              Effect.forever,
              Effect.forkChild,
            );
            const refused = yield* Fiber.join(stopped);
            yield* Fiber.interrupt(stepping);
            return refused;
          }).pipe(Effect.provide(TestClock.layer()));
          expect(runaway).toMatchObject({
            _tag: 'HistoryQueryRefused',
            reason: 'timeout',
          });
          const next = yield* query(session, 'SELECT count(*) FROM runs');
          expect(next.rows).toEqual([[1]]);
        }),
      ),
  );

  it.live('refuses a write and a second statement', () =>
    withSession((session) =>
      Effect.gen(function* () {
        publishTestRunStart(session);
        const write = yield* query(
          session,
          'WITH gone AS (SELECT 1) DELETE FROM events',
        ).pipe(Effect.flip);
        expect(write).toMatchObject({ reason: 'rejected' });
        const pragma = yield* query(session, 'PRAGMA query_only = OFF').pipe(
          Effect.flip,
        );
        expect(pragma).toMatchObject({ reason: 'not-a-read' });
        const two = yield* query(session, "SELECT 1; SELECT ';' -- ;").pipe(
          Effect.flip,
        );
        expect(two).toMatchObject({ reason: 'not-a-read' });
        const kept = yield* query(session, 'SELECT count(*) FROM events');
        expect(kept.rows).toEqual([[1]]);
      }),
    ),
  );

  it.live('fills runs from a view that reached the rows in events', () =>
    withSession((session) =>
      Effect.gen(function* () {
        yield* session.log.settled.pipe(Effect.orDie);
        const before = SubscriptionRef.getUnsafe(session.view.ref);
        publishTestRunStart(session);
        yield* session.log.settled.pipe(Effect.orDie);
        // A view whose current snapshot predates the run, and whose next
        // one has applied it.
        const lagging = {
          ...session.view,
          ref: yield* SubscriptionRef.make(before),
          changes: Stream.make(
            before,
            SubscriptionRef.getUnsafe(session.view.ref),
          ),
        };
        const history = yield* HistoryQuery.make(() => ({
          log: session.log,
          view: lagging,
        }));
        const page = yield* history.query(
          'SELECT (SELECT count(DISTINCT run_id) FROM events), (SELECT count(*) FROM runs)',
          [],
        );
        expect(page.rows).toEqual([[1, 1]]);
      }).pipe(Effect.scoped, Effect.provide(nodeSpawnerLayer)),
    ),
  );
});
