import '@test/support/sessionGraphTestSetup';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { aggregateId, emptyRunEndOutput, type RunId } from '@shared/schemas';
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
 * 5. A ledger row, a private record, or the session database's own tables
 *    are reachable from a query.
 * 6. A statement writes to the store or runs a second statement.
 */

const withSession = <A, E>(
  body: (session: SessionHandle) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => createTestSession()),
    body,
    closeSessionOf,
  );

const run = (runId: RunId) => aggregateId('run', runId);

const query = (session: SessionHandle, sql: string, params: string[] = []) =>
  Effect.gen(function* () {
    yield* session.settlePublications().pipe(Effect.orDie);
    return yield* session.history.query(sql, params);
  });

describe('HistoryQuery', () => {
  it.live('compiles every view against the current vocabulary', () =>
    withSession((session) =>
      Effect.gen(function* () {
        publishTestRunStart(session);
        for (const view of [
          'runs',
          'run_tree',
          'messages',
          'tool_calls',
          'usage',
          'todos',
          'events',
        ]) {
          const page = yield* query(session, `SELECT * FROM ${view}`);
          expect(page.columns.length).toBeGreaterThan(0);
        }
      }),
    ),
  );

  it.live('reports a resumed run by its latest lifecycle', () =>
    withSession((session) =>
      Effect.gen(function* () {
        const runId = publishTestRunStart(session);
        session.publish([
          {
            type: 'run.activate',
            aggregateId: run(runId),
            category: 'toolUse',
          },
          {
            type: 'run.end',
            aggregateId: run(runId),
            outcome: 'failed',
            output: emptyRunEndOutput('toolUse'),
          },
        ]);
        const ended = yield* query(
          session,
          'SELECT lifecycle, outcome FROM runs WHERE id = ?',
          [runId],
        );
        expect(ended.rows).toEqual([['ended', 'failed']]);

        session.publish([
          {
            type: 'run.activate',
            aggregateId: run(runId),
            category: 'toolUse',
          },
        ]);
        const resumed = yield* query(
          session,
          'SELECT lifecycle, outcome FROM runs WHERE id = ?',
          [runId],
        );
        expect(resumed.rows).toEqual([['activated', null]]);
      }),
    ),
  );

  it.live('drops a detached child from its former parent', () =>
    withSession((session) =>
      Effect.gen(function* () {
        const parent = publishTestRunStart(session);
        const child = publishTestRunStart(session, undefined, { parent });
        const before = yield* query(
          session,
          'SELECT id FROM run_tree WHERE ancestor_id = ?',
          [parent],
        );
        expect(before.rows).toEqual([[child]]);

        session.publish([{ type: 'run.detach', aggregateId: run(child) }]);
        const after = yield* query(
          session,
          'SELECT id FROM run_tree WHERE ancestor_id = ?',
          [parent],
        );
        expect(after.rows).toEqual([]);
      }),
    ),
  );

  it.live(
    'stops a runaway statement at its deadline and serves the next query',
    () =>
      withSession((session) =>
        Effect.gen(function* () {
          publishTestRunStart(session);
          const runaway = yield* query(
            session,
            'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n',
          ).pipe(Effect.flip);
          expect(runaway).toMatchObject({
            _tag: 'HistoryQueryRefused',
            reason: 'timeout',
          });
          const next = yield* query(session, 'SELECT count(*) FROM runs');
          expect(next.rows).toEqual([[1]]);
        }),
      ),
    { timeout: 20_000 },
  );

  it.live('holds display rows only', () =>
    withSession((session) =>
      Effect.gen(function* () {
        const runId = publishTestRunStart(session);
        session.publish([
          { type: 'run.report', aggregateId: run(runId), report: 'secret' },
        ]);
        const types = yield* query(session, 'SELECT DISTINCT type FROM events');
        expect(types.rows).toEqual([['run.start']]);
        const base = yield* query(session, 'SELECT * FROM event').pipe(
          Effect.flip,
        );
        expect(base).toMatchObject({
          _tag: 'HistoryQueryRefused',
          reason: 'rejected',
        });
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
});
