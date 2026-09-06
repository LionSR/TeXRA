/**
 * Read durable events before the live text that follows them. Changes in
 * the three source levels are only wakeups: each read captures text first,
 * then the log ordinal, and drains that finite prefix before yielding text.
 * Thus a committed run.start has reached this reader before its first chunk.
 */
import { Effect, Layer, Stream, SubscriptionRef } from 'effect';

import { SessionEventLog } from '@agent/runtime/SessionEvents';
import type { FoldInput, TextChunk } from '@shared/schemas';
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
    const log = yield* SessionEventLog;
    const local = yield* LocalRuntimeSource;
    const text = yield* TextChunkSource;
    return {
      read: (aggregates, fromCommit) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const anchor =
              fromCommit === 0
                ? yield* SubscriptionRef.get(log.level)
                : fromCommit;
            const listing = yield* Stream.runCollect(log.readListing());
            const replay: FoldInput[] = listing.map((event) => ({
              _tag: 'event',
              read: 'listing',
              event,
            }));
            replay.push({ _tag: 'subscriptions', set: [...aggregates] });
            for (const aggregate of aggregates) {
              const rows = yield* Stream.runCollect(
                log.readAggregate(aggregate.id, aggregate.fromSeq),
              );
              for (const event of rows) {
                replay.push({ _tag: 'event', read: 'aggregate', event });
              }
            }
            replay.push(
              { _tag: 'local', local: yield* SubscriptionRef.get(local.ref) },
              { _tag: 'replay.complete' },
              { _tag: 'drained', cursor: anchor },
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
                    const cursor = yield* SubscriptionRef.get(log.level);
                    const rows = yield* log.readAll(previous.cursor).pipe(
                      Stream.takeWhile((event) => event.commit <= cursor),
                      Stream.runCollect,
                    );
                    const batches: FoldInput[][] = rows.map((event) => [
                      {
                        _tag: 'event',
                        read: 'all',
                        event,
                      },
                    ]);
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
                      { _tag: 'drained', cursor },
                    );
                    batches.push(inputs);
                    return [{ cursor, text: nextText }, batches] as const;
                  }),
              ),
            );
            return Stream.concat(Stream.make(replay), tail);
          }),
        ),
    };
  }),
);
