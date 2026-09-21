/** Event-backed transcript reads fold the same entries the live recorder does. */
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer } from 'effect';
import { describe, expect, vi } from 'vitest';

import { databaseLayer } from '@controllers/session/Database';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import {
  aggregateId,
  isTranscriptEvent,
  type RunId,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import { Database, DatabaseReadFailed } from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { StreamLog } from '@shared/session/traceEntries';
import { createTranscriptFold } from '@shared/session/traceFold';
import { StreamLogStore } from '@transcript/StreamLogStore';

const RUN = 'ab12cd' as RunId;
const start: SessionEventDraft = {
  type: 'run.start',
  aggregateId: aggregateId('run', RUN),
  identity: { kind: 'agent', agent: 'chat' },
  userFollowUpSupport: 'unsupported',
  category: 'toolUse',
  isRemote: false,
  parent: null,
};
const substrate = databaseLayer('ephemeral').pipe(
  Layer.provide(
    Layer.succeed(WorkspaceRoots)({ storage: '/transcript-read-test' }),
  ),
  Layer.provide(ProcessIdentity.layer('["test-host",4242,"self-start"]')),
);

const history: SessionEventDraft[] = [
  start,
  {
    type: 'stage.start',
    aggregateId: start.aggregateId,
    id: 'round',
    label: 'Round 1',
    kind: 'round',
  },
  {
    type: 'stream.start',
    aggregateId: start.aggregateId,
    id: 'response',
    kind: 'modelResponse',
    stageId: 'round',
  },
  {
    type: 'stream.end',
    aggregateId: start.aggregateId,
    id: 'response',
    finalText: 'The integral vanishes.',
  },
  {
    type: 'stage.end',
    aggregateId: start.aggregateId,
    id: 'round',
    status: 'completed',
  },
];

describe('StreamLogStore event reads', () => {
  it.effect(
    'folds cold reads identically to live entries without retaining them',
    () =>
      Effect.gen(function* () {
        const database = yield* Database;
        const rows = yield* database.appendAll(history);
        const store = StreamLogStore.open(database);
        const live = new StreamLog();
        const fold = createTranscriptFold(live);
        for (const row of rows) {
          if (isTranscriptEvent(row))
            fold.record(row, {
              at: row.at,
              id: JSON.stringify([row.aggregateId, row.seq]),
              debug: row.transcriptDebug ?? false,
            });
        }
        expect(yield* store.readEntries(RUN)).toEqual(live.toJSON());
        expect(store.get(RUN)).toBeUndefined();
        yield* store.ensureLoaded(RUN);
        expect(store.get(RUN)?.toJSON()).toEqual(live.toJSON());
      }).pipe(Effect.provide(substrate)),
  );

  it.effect('observes committed deletion even when the cache is older', () =>
    Effect.gen(function* () {
      const database = yield* Database;
      yield* database.appendAll(history);
      const store = StreamLogStore.open(database);
      yield* database.appendAll([
        { type: 'run.removed', aggregateId: start.aggregateId },
      ]);
      expect(yield* store.readEvents(RUN)).toEqual([]);
      expect(yield* store.readEntries(RUN)).toEqual([]);
      yield* store.ensureLoaded(RUN);
      expect(store.get(RUN)).toBeUndefined();
    }).pipe(Effect.provide(substrate)),
  );

  it.effect(
    'seeds a retained run from its rows and advances it from the tail',
    () =>
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.appendAll(history);
        const store = StreamLogStore.open(database);
        const lease = yield* store.acquireRunResidency(RUN);
        expect(store.get(RUN)?.toJSON()).toEqual(yield* store.readEntries(RUN));

        const appended = yield* database.appendAll([
          {
            type: 'log',
            aggregateId: start.aggregateId,
            level: 'info',
            message: 'Committed after the seed',
          },
        ]);
        for (const row of appended) store.acceptCommitted(row);
        expect(store.get(RUN)?.toJSON()).toEqual(yield* store.readEntries(RUN));
        expect(
          store
            .get(RUN)
            ?.toJSON()
            .filter((entry) => entry.text === 'Committed after the seed'),
        ).toHaveLength(1);

        // A lease outranks an eviction request; the cache goes once it closes
        // and the next request finds nothing holding the run.
        store.requestEviction(RUN);
        expect(store.get(RUN)).toBeDefined();
        lease.close();
        store.requestEviction(RUN);
        expect(store.get(RUN)).toBeUndefined();
      }).pipe(Effect.provide(substrate)),
  );

  it.effect(
    'caches nothing for an unheld run and forgets a removed one through the tail',
    () =>
      Effect.gen(function* () {
        const database = yield* Database;
        const store = StreamLogStore.open(database);
        const rows = yield* database.appendAll(history);
        for (const row of rows) store.acceptCommitted(row);
        expect(store.get(RUN)).toBeUndefined();
        yield* store.ensureLoaded(RUN);
        expect(store.get(RUN)?.toJSON().length).toBeGreaterThan(0);
        const removed = yield* database.appendAll([
          { type: 'run.removed', aggregateId: start.aggregateId },
        ]);
        for (const row of removed) store.acceptCommitted(row);
        expect(store.get(RUN)).toBeUndefined();
      }).pipe(Effect.provide(substrate)),
  );
  it.effect(
    'a failed acquisition leaves no stub behind in ephemeral mode either',
    () =>
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.appendAll(history);
        const store = StreamLogStore.open(database, {
          kind: 'ephemeral',
          reason: 'test',
        });
        const failure = new DatabaseReadFailed({
          path: 'runs/ab12cd',
          cause: new Error('KV timeout'),
        });
        vi.spyOn(database, 'readAggregate').mockReturnValue(
          Effect.fail(failure),
        );
        expect(yield* Effect.flip(store.acquireRunResidency(RUN))).toBe(
          failure,
        );
        expect(store.get(RUN)).toBeUndefined();
      }).pipe(Effect.provide(substrate)),
  );
  it.effect(
    'defers an eviction that arrives while a lease still holds the run',
    () =>
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.appendAll(history);
        const store = StreamLogStore.open(database);
        const lease = yield* store.acquireRunResidency(RUN);
        store.requestEviction(RUN);
        expect(store.get(RUN)).toBeDefined();
        lease.close();
        expect(store.get(RUN)).toBeUndefined();
      }).pipe(Effect.provide(substrate)),
  );

  it.effect('honors an eviction requested during a cold seed read', () =>
    Effect.gen(function* () {
      const database = yield* Database;
      yield* database.appendAll(history);
      const store = StreamLogStore.open(database);
      // The read announces that it started and then waits to be released, so
      // the eviction below lands while the seed read is in flight.
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<readonly SessionEvent[]>();
      vi.spyOn(database, 'readAggregate').mockImplementationOnce(() =>
        Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      );
      const fiber = yield* Effect.forkChild(store.ensureLoaded(RUN));
      yield* Deferred.await(reached);
      store.requestEviction(RUN);
      yield* Deferred.succeed(release, []);
      yield* Fiber.join(fiber);
      expect(store.get(RUN)).toBeUndefined();
    }).pipe(Effect.provide(substrate)),
  );
});
