/**
 * The session event plane's service shape (PRD one-fold-three-renderers,
 * 7.1, contract C7): what every fold reads, in the runtime and in a
 * webview alike. The reads are `listing()` (the cold hydrate, completes),
 * `all(fromCommit)` (every row above a commit ordinal, then the tail), and
 * `aggregate(id, fromSeq)` (one aggregate's rows from a seq, completes);
 * `publish` is the runtime's only. The runtime layer over the in-memory
 * log lives beside the log in `@agent/runtime/SessionEvents`; the
 * transport layer here reads the frames a `Subscribe` started, so a
 * renderer process holds nothing of Node in its graph.
 */
import {
  Context,
  Effect,
  Layer,
  type Stream,
  type SubscriptionRef,
} from 'effect';

import type {
  AggregateId,
  CommitOrdinal,
  OwnerId,
  SessionEvent,
  SessionEventDraft,
} from '@shared/schemas';

import { SessionFrames } from './sessionFrames';

/** A publisher's position in the commit space: what `all` reads from. */
export type SessionCursor = CommitOrdinal;

/**
 * The identity of this process, `${pid}:${processStart}` (contract C5): the
 * `ownerId` stamped on every event the process appends and the `self` entry
 * of its local runtime snapshot. Resolved once at each process entry, where
 * the start identity can be awaited, and provided to the process layer.
 */
export class ProcessIdentity extends Context.Service<
  ProcessIdentity,
  { readonly ownerId: OwnerId }
>()('@texra/session/ProcessIdentity') {
  static layer(ownerId: OwnerId): Layer.Layer<ProcessIdentity> {
    return Layer.succeed(ProcessIdentity)({ ownerId });
  }
}

export class SessionEvents extends Context.Service<
  SessionEvents,
  {
    /** An ordered batch, committed in one transaction (PRD 6, item 8). */
    readonly publish: (
      events: readonly SessionEventDraft[],
    ) => Effect.Effect<void>;
    /** The cold listing hydrate (C8): the latest row per aggregate and type
     *  for the listing fact types plus the outstanding approvals, in commit
     *  order; never a transcript row; completes. */
    readonly listing: () => Stream.Stream<SessionEvent>;
    /** Every event with commit above `fromCommit`, in commit order across
     *  aggregates, then the tail. Transcript rows of unsubscribed aggregates
     *  included: the live tail and the frozen NDJSON projection read it.
     *  `drained`, when given, receives the commit each forward read of the
     *  tail covered, rows it could not materialize included, once every row
     *  of that read has reached the reader; the transport plane never sets
     *  it. */
    readonly all: (
      fromCommit: SessionCursor,
      drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
    ) => Stream.Stream<SessionEvent>;
    /** One aggregate's rows from `fromSeq`, in seq order; completes. A
     *  history read, never a tail. */
    readonly aggregate: (
      aggregateId: AggregateId,
      fromSeq: number,
    ) => Stream.Stream<SessionEvent>;
    /** Where this layer's tail starts, fixed at layer build. A value, not a
     *  query: the fold never reads a durable ordinal. */
    readonly anchor: SessionCursor;
  }
>()('@texra/session/SessionEvents') {
  /**
   * The plane as a webview reads it (PRD 7.4): the three reads over the
   * frames a `Subscribe` started. `SessionFrames` is the decoder's service:
   * it routes each row to its read's queue and ends the listing and
   * aggregate queues at the frame that carries `replayComplete` (8.1), so
   * the fold fiber's `Stream.concat` over these reads is the same code as
   * in the runtime. `all` ignores its argument: the tail is the frames after
   * that marker, anchored by the runtime at the `Subscribe` cursor. The
   * anchor is 0: the webview's cursor is its own fold's, advanced by the
   * tail rows it folds and carried back up by its next `Subscribe`; no
   * durable ordinal exists here and none is read.
   */
  static readonly transportLayer = Layer.effect(
    SessionEvents,
    Effect.gen(function* () {
      const frames = yield* SessionFrames;
      return {
        publish: () => Effect.die(new Error('A webview cannot publish')),
        listing: () => frames.listing(),
        all: () => frames.events(),
        aggregate: (aggregateId, fromSeq) =>
          frames.aggregate(aggregateId, fromSeq),
        anchor: 0,
      };
    }),
  );
}

export type SessionEventsShape = Context.Service.Shape<typeof SessionEvents>;
