/**
 * Read durable events before the live text that follows them. Changes in
 * the three source levels are only wakeups: each read captures text first,
 * then the log ordinal, and drains that finite prefix before yielding text.
 * Thus a committed run.start has reached this reader before its first chunk.
 */
import { Effect, Layer, Stream, SubscriptionRef } from 'effect';

import {
  aggregateId,
  referencedAggregates,
  type AggregateId,
  type ExistenceReconciliation,
  type FoldInput,
  type TextChunk,
} from '@shared/schemas';
import { Database, type AggregateState } from '@shared/session/database';
import { SessionInputs } from '@shared/session/sessionInputs';
import {
  SessionReaderError,
  sessionMessageBytes,
} from '@shared/session/sessionReadBudget';
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
      read: (aggregates, fromCommit, budget) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const named = new Set(aggregates.map(({ id }) => id));
            const anchor =
              fromCommit === 0
                ? yield* log.currentCommit.pipe(Effect.orDie)
                : fromCommit;
            const replay: FoldInput[] = [];
            let replayBytes = 0;
            const remaining = () =>
              budget
                ? {
                    bytes: Math.max(0, budget.bytes - replayBytes),
                    rows: Math.max(0, budget.rows - replay.length),
                  }
                : undefined;
            const appendReplay = (input: FoldInput): void => {
              if (budget) {
                replayBytes += sessionMessageBytes(input);
                if (
                  replayBytes > budget.bytes ||
                  replay.length >= budget.rows
                ) {
                  throw new SessionReaderError(
                    'This conversation exceeds the history display limit. Its saved content is unchanged.',
                  );
                }
              }
              replay.push(input);
            };
            const listing = yield* log
              .readListing(remaining())
              .pipe(Effect.orDie);
            let checked = new Set<AggregateId>(aggregates.map(({ id }) => id));
            for (const event of listing)
              for (const id of referencedAggregates(event)) checked.add(id);
            for (const event of listing)
              appendReplay({ _tag: 'event', read: 'listing', event });
            appendReplay({ _tag: 'subscriptions', set: [...aggregates] });
            for (const aggregate of aggregates) {
              const rows = yield* log
                .readAggregate(aggregate.id, aggregate.fromSeq, remaining())
                .pipe(Effect.orDie);
              for (const event of rows) {
                appendReplay({ _tag: 'event', read: 'aggregate', event });
              }
            }
            const replayState = yield* log
              .readInputBatch(
                aggregates.map(({ id }) => id),
                anchor,
                [...checked],
                remaining(),
              )
              .pipe(Effect.orDie);
            const replayExistence = reconcileExistence(replayState);
            checked = new Set(
              replayExistence.claims.map(({ aggregateId }) => aggregateId),
            );
            appendReplay({
              _tag: 'local',
              local: yield* SubscriptionRef.get(local.ref),
            });
            appendReplay({
              _tag: 'replay.complete',
              existence: replayExistence,
            });
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
                        budget ?? undefined,
                      )
                      .pipe(Effect.orDie);
                    const { cursor, events: rows } = read;
                    const existence = reconcileExistence(read);
                    checked = new Set(
                      existence.claims.map(({ aggregateId }) => aggregateId),
                    );
                    const inputs: FoldInput[] = [];
                    let bytes = 0;
                    const checkBudget = (): void => {
                      if (
                        budget &&
                        (bytes > budget.bytes || inputs.length >= budget.rows)
                      ) {
                        throw new SessionReaderError(
                          'This conversation exceeds the history display limit. Its saved content is unchanged.',
                        );
                      }
                    };
                    const append = (input: FoldInput): void => {
                      if (budget) bytes += sessionMessageBytes(input);
                      checkBudget();
                      inputs.push(input);
                    };
                    for (const event of rows)
                      append({ _tag: 'event', read: 'all', event });
                    const selectedText = new Map<string, InflightTextChunk>();
                    for (const [key, value] of nextText) {
                      const slash = key.indexOf('/');
                      const streamId = key.slice(0, slash);
                      // Ignore other runs before walking or retaining their tails.
                      if (!named.has(aggregateId('stream', streamId))) continue;
                      selectedText.set(key, value);
                      const held = previous.text.get(key);
                      if (value === held) continue;
                      // Visit only appends since this reader's captured tail.
                      // A replacement row starts a new chain and reads from 0.
                      const parts: string[] = [];
                      let at: InflightTextChunk | undefined = value;
                      while (at !== undefined && at !== held) {
                        if (budget) bytes += sessionMessageBytes(at.text);
                        checkBudget();
                        parts.push(at.text);
                        at = at.previous;
                      }
                      const from = at === held ? (held?.length ?? 0) : 0;
                      if (value.length <= from) continue;
                      const chunk: TextChunk = {
                        _tag: 'chunk',
                        streamId,
                        rowId: key.slice(slash + 1),
                        from,
                        to: value.length,
                        text: parts.toReversed().join(''),
                      };
                      // Text was charged before joining its fragments; charge
                      // the envelope separately without encoding the text again.
                      if (budget)
                        bytes += sessionMessageBytes({ ...chunk, text: '' });
                      checkBudget();
                      inputs.push(chunk);
                    }
                    append({ _tag: 'local', local: snapshot });
                    append({ _tag: 'drained', cursor, existence });
                    return [{ cursor, text: selectedText }, [inputs]] as const;
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
