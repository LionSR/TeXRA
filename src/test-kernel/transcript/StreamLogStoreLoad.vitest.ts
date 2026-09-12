/** Event-backed transcript reads retain the same fold and ownership rules. */
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer } from 'effect';
import { describe, expect } from 'vitest';

import { databaseLayer } from '@controllers/session/Database';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import {
  aggregateId,
  isTranscriptEvent,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import { Database } from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { StreamLog } from '@shared/session/traceEntries';
import { createTranscriptFold } from '@shared/session/traceFold';
import { StreamLogStore } from '@transcript/StreamLogStore';

const RUN = 'ab12cd' as RunId;
const OTHER_RUN = 'bb34ef' as RunId;
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
        const store = yield* StreamLogStore.open(database);
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
        expect(store.has(RUN)).toBe(true);
        expect(yield* store.readEntries(RUN)).toEqual(live.toJSON());
        expect(store.get(RUN)).toBeUndefined();
        yield* store.ensureLoaded(RUN);
        expect(store.get(RUN)?.toJSON()).toEqual(live.toJSON());
      }).pipe(Effect.provide(substrate)),
  );

  it.effect(
    'observes committed deletion even when the local listing is older',
    () =>
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.appendAll(history);
        const store = yield* StreamLogStore.open(database);
        yield* database.appendAll([
          { type: 'run.removed', aggregateId: start.aggregateId },
        ]);
        expect(yield* store.hasAuthoritativeRun(RUN)).toBe(false);
        expect(yield* store.readEntries(RUN)).toEqual([]);
        yield* store.ensureLoaded(RUN);
        expect(store.has(RUN)).toBe(false);
      }).pipe(Effect.provide(substrate)),
  );

  it.effect(
    'reserves the writer across hydration and concurrent eviction',
    () =>
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.appendAll(history);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const store = yield* StreamLogStore.open({
          readListing: database.readListing,
          readAggregate: (id, seq) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* database.readAggregate(id, seq);
            }),
        });
        const loading = yield* Effect.forkChild(store.acquireRunResidency(RUN));
        yield* Deferred.await(entered);
        store.requestEviction(RUN);
        yield* Deferred.succeed(release, undefined);
        const writer = yield* Fiber.join(loading);
        expect(store.get(RUN)?.toJSON().length).toBeGreaterThan(0);
        const successor = yield* store.acquireRunResidency(RUN);
        writer.close();
        expect(store.get(RUN)).toBeDefined();
        successor.close();
        expect(store.get(RUN)).toBeUndefined();
      }).pipe(Effect.provide(substrate)),
  );

  it.effect(
    'serializes tail delivery with a captured cold prefix without losing or duplicating rows',
    () =>
      Effect.gen(function* () {
        const database = yield* Database;
        const prefix = yield* database.appendAll(history);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const store = yield* StreamLogStore.open({
          readListing: database.readListing,
          readAggregate: (id, seq) =>
            Effect.gen(function* () {
              const captured = yield* database.readAggregate(id, seq);
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return captured;
            }),
        });
        const loading = yield* Effect.forkChild(store.acquireRunResidency(RUN));
        yield* Deferred.await(entered);
        const suffix = yield* database.appendAll([
          {
            type: 'log',
            aggregateId: start.aggregateId,
            level: 'info',
            message: 'Committed during hydration',
          },
        ]);
        const tail = yield* Effect.forkChild(
          Effect.forEach([...prefix, ...suffix], (event) =>
            store.acceptCommitted(event),
          ),
        );
        yield* Deferred.succeed(release, undefined);
        const writer = yield* Fiber.join(loading);
        yield* Fiber.join(tail);
        expect(store.get(RUN)?.toJSON()).toEqual(yield* store.readEntries(RUN));
        expect(
          store
            .get(RUN)
            ?.toJSON()
            .filter((entry) => entry.text === 'Committed during hydration'),
        ).toHaveLength(1);
        writer.close();
      }).pipe(Effect.provide(substrate)),
  );

  it.effect(
    'hydrates the complete prefix when a tail row was queued before writer acquisition',
    () =>
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.appendAll(history);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const other = aggregateId('run', OTHER_RUN);
        const store = yield* StreamLogStore.open({
          readListing: database.readListing,
          readAggregate: (id, seq) =>
            Effect.gen(function* () {
              if (id === other) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return yield* database.readAggregate(id, seq);
            }),
        });
        const blocking = yield* Effect.forkChild(store.ensureLoaded(OTHER_RUN));
        yield* Deferred.await(entered);
        const suffix = yield* database.appendAll([
          {
            type: 'log',
            aggregateId: start.aggregateId,
            level: 'info',
            message: 'Committed before writer acquisition',
          },
        ]);
        const tail = yield* Effect.forkChild(store.acceptCommitted(suffix[0]!));
        yield* Effect.yieldNow;
        const loading = yield* Effect.forkChild(store.acquireRunResidency(RUN));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(blocking);
        yield* Fiber.join(tail);
        const writer = yield* Fiber.join(loading);
        expect(store.get(RUN)?.toJSON()).toEqual(yield* store.readEntries(RUN));
        writer.close();
      }).pipe(Effect.provide(substrate)),
  );

  it.effect(
    'observes another writer creation and deletion through the committed tail',
    () =>
      Effect.gen(function* () {
        const database = yield* Database;
        const store = yield* StreamLogStore.open(database);
        const rows = yield* database.appendAll(history);
        yield* Effect.forEach(rows, (row) => store.acceptCommitted(row));
        expect(store.has(RUN)).toBe(true);
        yield* store.ensureLoaded(RUN);
        const removed = yield* database.appendAll([
          { type: 'run.removed', aggregateId: start.aggregateId },
        ]);
        yield* Effect.forEach(removed, (row) => store.acceptCommitted(row));
        expect(store.has(RUN)).toBe(false);
        expect(store.get(RUN)).toBeUndefined();
      }).pipe(Effect.provide(substrate)),
  );
});
