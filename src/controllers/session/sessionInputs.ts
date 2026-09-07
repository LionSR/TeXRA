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
    const log = yield* SessionEventLog;
    const local = yield* LocalRuntimeSource;
    const text = yield* TextChunkSource;
    return {
      read: (aggregates, fromCommit, budget) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const anchor =
              fromCommit === 0
                ? yield* SubscriptionRef.get(log.level)
                : fromCommit;
            const replay: FoldInput[] = [];
            let replayBytes = 0;
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
            yield* Stream.runForEach(log.readListing(), (event) =>
              Effect.sync(() => {
                appendReplay({ _tag: 'event', read: 'listing', event });
              }),
            );
            appendReplay({ _tag: 'subscriptions', set: [...aggregates] });
            for (const aggregate of aggregates) {
              yield* Stream.runForEach(
                log.readAggregate(
                  aggregate.id,
                  aggregate.fromSeq,
                  budget
                    ? {
                        bytes: Math.max(0, budget.bytes - replayBytes),
                        rows: Math.max(0, budget.rows - replay.length),
                      }
                    : undefined,
                ),
                (event) =>
                  Effect.sync(() => {
                    appendReplay({ _tag: 'event', read: 'aggregate', event });
                  }),
              );
            }
            appendReplay({
              _tag: 'local',
              local: yield* SubscriptionRef.get(local.ref),
            });
            appendReplay({ _tag: 'replay.complete' });
            appendReplay({ _tag: 'drained', cursor: anchor });
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
                    const batches: FoldInput[][] = [];
                    let bytes = 0;
                    let rows = 0;
                    const checkBudget = (): void => {
                      if (
                        budget &&
                        (bytes > budget.bytes || rows >= budget.rows)
                      )
                        throw new SessionReaderError(
                          'This conversation exceeds the history display limit. Its saved content is unchanged.',
                        );
                    };
                    const charge = (input: FoldInput): void => {
                      if (budget) bytes += sessionMessageBytes(input);
                      checkBudget();
                      rows += 1;
                    };
                    yield* log.readAll(previous.cursor).pipe(
                      Stream.takeWhile((event) => event.commit <= cursor),
                      Stream.runForEach((event) =>
                        Effect.sync(() => {
                          charge({ _tag: 'event', read: 'all', event });
                          batches.push([{ _tag: 'event', read: 'all', event }]);
                        }),
                      ),
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
                        if (budget) {
                          bytes += sessionMessageBytes(at.text);
                          checkBudget();
                        }
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
                      // Fragments were charged before joining. Charge the row
                      // envelope and the shared row count before retaining it.
                      if (budget)
                        bytes += sessionMessageBytes({ ...chunk, text: '' });
                      checkBudget();
                      rows += 1;
                      inputs.push(chunk);
                    }
                    const localInput: FoldInput = {
                      _tag: 'local',
                      local: snapshot,
                    };
                    charge(localInput);
                    inputs.push(localInput);
                    const drained: FoldInput = { _tag: 'drained', cursor };
                    charge(drained);
                    inputs.push(drained);
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
