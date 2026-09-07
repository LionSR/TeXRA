/**
 * The session event plane over its root's SQLite database. Publication commits
 * an ordered batch before waking readers. Listing and aggregate reads are
 * finite; each tail wake captures a committed upper bound and drains that
 * prefix. Wake counters and commit ordinals are separate coordinates, so a
 * claim change can wake a reader without inventing an event.
 */
// Node imports
import { hostname } from 'node:os';

// Third-party imports
import { Effect, Layer, Ref, Stream, SubscriptionRef } from 'effect';

import type { AgentEvent, StatusEvent } from '@agent/trace';
import {
  aggregateId as qualifyAggregateId,
  type CommitOrdinal,
  type OwnerId,
  type SessionEvent,
  type SessionEventDraft,
  type StreamTabId,
} from '@shared/schemas';
import { Database } from '@shared/session/database';
import {
  SessionEvents,
  type SessionCursor,
} from '@shared/session/sessionEvents';

/** This process's complete owner identity (contract C5). */
export function processOwnerId(processStart: string | undefined): OwnerId {
  return JSON.stringify([
    hostname().toLowerCase(),
    process.pid,
    processStart ?? null,
  ]);
}

/** The tail drain (C7): read forward from the caller's position on each
 * wake, never past the committed upper bound captured for that read. A level says "there is more", not "there is one more", so a
 * burst of commits during a read collapses into one further read. A read
 * delivers up to the level it started at whether or not every row in
 * between materialized, so a row the read could not deliver is not read
 * again on every later wake.
 *
 * `drained`, when given, receives the commit each forward read covered,
 * rows the read could not materialize included, and only once every row of
 * that read has reached the reader (it is set after the read's stream
 * completes). A row the store no longer holds emits nothing, so a reader
 * that must know the tail passed an ordinal (the NDJSON detach drain) waits
 * on this coordinate, never on the events alone.
 */
export function tailFrom(
  read: (fromCommit: SessionCursor) => Stream.Stream<SessionEvent>,
  level: {
    readonly get: Effect.Effect<CommitOrdinal>;
    readonly changes: Stream.Stream<CommitOrdinal>;
  },
  fromCommit: SessionCursor,
  drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
): Stream.Stream<SessionEvent> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const at = yield* Ref.make(fromCommit);
      const forward = Stream.unwrap(
        Effect.gen(function* () {
          const cursor = yield* Ref.get(at);
          const upTo = yield* level.get;
          return Stream.concat(
            read(cursor).pipe(
              Stream.takeWhile((event) => event.commit <= upTo),
              Stream.tap((event) => Ref.set(at, event.commit)),
            ),
            Stream.fromEffect(
              Effect.gen(function* () {
                const covered = yield* Ref.updateAndGet(at, (delivered) =>
                  Math.max(delivered, upTo),
                );
                if (drained) yield* SubscriptionRef.set(drained, covered);
              }),
            ).pipe(Stream.drain),
          );
        }),
      );
      return level.changes.pipe(
        Stream.flatMap(() => forward, { concurrency: 1 }),
      );
    }),
  );
}

/**
 * The publisher and public event readers over the root's database. Each
 * reader supplies its own starting position.
 */
export const sessionEventsLayer = Layer.effect(
  SessionEvents,
  Effect.gen(function* () {
    const log = yield* Database;
    const publish = Effect.fn('SessionEvents.publish')(function* (
      events: readonly SessionEventDraft[],
    ) {
      return yield* log.appendAll(events).pipe(Effect.orDie);
    });
    // THE tail (C7): the drain woken by the log's level.
    const all = (
      fromCommit: SessionCursor,
      drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
    ): Stream.Stream<SessionEvent> =>
      tailFrom(
        (from) =>
          Stream.fromIterableEffect(log.readAll(from).pipe(Effect.orDie)),
        {
          get: log.currentCommit.pipe(Effect.orDie),
          changes: SubscriptionRef.changes(log.level),
        },
        fromCommit,
        drained,
      );
    return {
      publish,
      listing: () =>
        Stream.fromIterableEffect(log.readListing().pipe(Effect.orDie)),
      all,
      aggregate: (aggregateId, fromSeq) =>
        Stream.fromIterableEffect(
          log.readAggregate(aggregateId, fromSeq).pipe(Effect.orDie),
        ),
    };
  }),
);

/** A source trace fact on its stream aggregate. Streaming chunks remain transient. */
export function runEventDraft(
  streamId: StreamTabId,
  event: AgentEvent,
): SessionEventDraft | null {
  const aggregateId = qualifyAggregateId('stream', streamId);
  switch (event.type) {
    case 'stream.chunk':
    case 'child.activity':
      return null;
    case 'usage':
      return {
        type: event.type,
        aggregateId,
        ...event.payload,
        recordTranscript: event.recordTranscript,
        stageId: event.stageId,
      };
    default:
      // Trace arrays are readonly; publication validates and serializes them
      // at the database boundary without changing their contents.
      return { ...event, aggregateId } as SessionEventDraft;
  }
}

/** The `status` arm of one canonical status fact, on the stream it names. */
export function statusDraft(event: StatusEvent): SessionEventDraft {
  return {
    ...event,
    aggregateId: qualifyAggregateId('stream', event.streamId),
  };
}
