/**
 * Read durable events before the live text that follows them. Changes in
 * the three source levels are only wakeups: each read captures text first,
 * then the log ordinal, and drains that finite prefix before yielding text.
 * Thus a committed run.start has reached this reader before its first chunk.
 */
// Node imports
import { isDeepStrictEqual } from 'node:util';

// Third-party imports
import { Effect, Layer, Stream, SubscriptionRef } from 'effect';

import {
  referencedAggregates,
  isDisplaySessionEvent,
  RunIdSchema,
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
            const listing = (yield* log
              .readListing()
              .pipe(Effect.orDie)).filter(isDisplaySessionEvent);
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
              for (const event of rows.filter(isDisplaySessionEvent)) {
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
            const initialLocal = yield* SubscriptionRef.get(local.ref);
            replay.push(
              { _tag: 'local', local: initialLocal },
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
              // Wakeups carry no data: the next read captures every source's
              // current level. Retain one pending read, not a backlog of reads
              // of the same state after a burst of text chunks.
              Stream.buffer({ capacity: 1, strategy: 'dropping' }),
              Stream.mapAccumEffect(
                () => ({
                  cursor: anchor,
                  text: new Map() as InflightText,
                  local: initialLocal,
                  // The first drain must publish the anchor: replay.complete
                  // reconciles existence but does not advance the view cursor.
                  existence: undefined as ExistenceReconciliation | undefined,
                }),
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
                        runId: RunIdSchema.parse(key.slice(0, slash)),
                        rowId: key.slice(slash + 1),
                        from,
                        to: value.length,
                        text: parts.toReversed().join(''),
                      };
                      inputs.push(chunk);
                    }
                    if (!isDeepStrictEqual(previous.local, snapshot)) {
                      inputs.push({ _tag: 'local', local: snapshot });
                    }
                    if (
                      inputs.length > 0 ||
                      rows.length > 0 ||
                      cursor !== previous.cursor ||
                      !isDeepStrictEqual(previous.existence, existence)
                    ) {
                      // Every nonempty batch needs its closing marker so the
                      // webview decoder can release it as one complete read.
                      inputs.push({ _tag: 'drained', cursor, existence });
                    }
                    const batch: FoldInput[] = [
                      ...rows
                        .filter(isDisplaySessionEvent)
                        .map((event): FoldInput => ({
                          _tag: 'event',
                          read: 'all',
                          event,
                        })),
                      ...inputs,
                    ];
                    return [
                      { cursor, text: nextText, local: snapshot, existence },
                      batch.length === 0 ? [] : [batch],
                    ] as const;
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
