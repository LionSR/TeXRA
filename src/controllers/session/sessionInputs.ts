/**
 * Read durable events before the live text that follows them. Changes in
 * the three source levels are only wakeups: each read captures text first,
 * then the log ordinal, and drains that finite prefix before yielding text.
 * Thus a committed run.start has reached this reader before its first chunk.
 */
import { Effect, Layer, Stream, SubscriptionRef } from 'effect';

import {
  referencedAggregates,
  type AggregateId,
  type ExistenceReconciliation,
  type FoldInput,
  type TextChunk,
} from '@shared/schemas';
import { Database, type AggregateState } from '@shared/session/database';
import { SessionInputs } from '@shared/session/sessionInputs';
import {
  LocalRuntimeSource,
  TextChunkSource,
  type InflightText,
  type InflightTextChunk,
} from './sessionSources';

export const sessionInputsLayer = Layer.effect(
  SessionInputs,
  Effect.gen(function* () {
    const log = yield* Database;
    const local = yield* LocalRuntimeSource;
    const text = yield* TextChunkSource;
    return {
      read: (aggregates, fromCommit) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const anchor =
              fromCommit === 0
                ? yield* log.currentCommit.pipe(Effect.orDie)
                : fromCommit;
            const listing = yield* log.readListing().pipe(Effect.orDie);
            let checked = new Set<AggregateId>(aggregates.map(({ id }) => id));
            for (const event of listing)
              for (const id of referencedAggregates(event)) checked.add(id);
            const replay: FoldInput[] = listing.map((event) => ({
              _tag: 'event',
              read: 'listing',
              event,
            }));
            replay.push({ _tag: 'subscriptions', set: [...aggregates] });
            for (const aggregate of aggregates) {
              const rows = yield* log
                .readAggregate(aggregate.id, aggregate.fromSeq)
                .pipe(Effect.orDie);
              for (const event of rows) {
                replay.push({ _tag: 'event', read: 'aggregate', event });
              }
            }
            const replayState = yield* log
              .readInputBatch(
                aggregates.map(({ id }) => id),
                anchor,
                [...checked],
              )
              .pipe(Effect.orDie);
            const replayExistence = reconcileExistence(replayState);
            checked = new Set(
              replayExistence.claims.map(({ aggregateId }) => aggregateId),
            );
            replay.push(
              { _tag: 'local', local: yield* SubscriptionRef.get(local.ref) },
              { _tag: 'replay.complete', existence: replayExistence },
            );
            // Every level replays on subscribe; changes during the cold read
            // are therefore covered by the first finite tail read.
            const wakes = Stream.mergeAll(
              [
                SubscriptionRef.changes(log.level).pipe(
                  Stream.map(() => undefined),
                ),
                SubscriptionRef.changes(local.ref).pipe(
                  Stream.map(() => undefined),
                ),
                SubscriptionRef.changes(text.ref).pipe(
                  Stream.map(() => undefined),
                ),
              ],
              { concurrency: 3 },
            );
            const tail = wakes.pipe(
              Stream.mapAccumEffect(
                () => ({ cursor: anchor, text: new Map() as InflightText }),
                (previous) =>
                  Effect.gen(function* () {
                    const nextText = yield* SubscriptionRef.get(text.ref);
                    const snapshot = yield* SubscriptionRef.get(local.ref);
                    const read = yield* log
                      .readInputBatch(
                        aggregates.map(({ id }) => id),
                        previous.cursor,
                        [
                          ...new Set([
                            ...checked,
                            ...aggregates.map(({ id }) => id),
                          ]),
                        ],
                      )
                      .pipe(Effect.orDie);
                    const { cursor, events: rows } = read;
                    const existence = reconcileExistence(read);
                    checked = new Set(
                      existence.claims.map(({ aggregateId }) => aggregateId),
                    );
                    const inputs: FoldInput[] = [];
                    for (const [key, value] of nextText) {
                      const held = previous.text.get(key);
                      if (value === held) continue;
                      // Visit only appends since this reader's captured tail.
                      // A replacement row starts a new chain and reads from 0.
                      const parts: string[] = [];
                      let at: InflightTextChunk | undefined = value;
                      while (at !== undefined && at !== held) {
                        parts.push(at.text);
                        at = at.previous;
                      }
                      const from = at === held ? (held?.length ?? 0) : 0;
                      if (value.length <= from) continue;
                      const slash = key.indexOf('/');
                      const chunk: TextChunk = {
                        _tag: 'chunk',
                        streamId: key.slice(0, slash),
                        rowId: key.slice(slash + 1),
                        from,
                        to: value.length,
                        text: parts.toReversed().join(''),
                      };
                      inputs.push(chunk);
                    }
                    inputs.push(
                      { _tag: 'local', local: snapshot },
                      { _tag: 'drained', cursor, existence },
                    );
                    const batch: FoldInput[] = [
                      ...rows.map((event): FoldInput => ({
                        _tag: 'event',
                        read: 'all',
                        event,
                      })),
                      ...inputs,
                    ];
                    return [{ cursor, text: nextText }, [batch]] as const;
                  }),
              ),
            );
            return Stream.concat(Stream.make(replay), tail);
          }),
        ),
    };
  }),
);

/** Closed sequence rows are no longer live, even while their tombstones remain stored. */
function reconcileExistence(read: {
  readonly checkedAggregateIds: readonly AggregateId[];
  readonly state: readonly AggregateState[];
}): ExistenceReconciliation {
  const surviving = read.state.filter((state) => !state.closed);
  const present = new Set(surviving.map(({ aggregateId }) => aggregateId));
  return {
    checkedAggregateIds: [...read.checkedAggregateIds],
    removedAggregateIds: read.checkedAggregateIds.filter(
      (id) => !present.has(id),
    ),
    claims: surviving.map(({ aggregateId, ownerId }) => ({
      aggregateId,
      ownerId,
    })),
  };
}
