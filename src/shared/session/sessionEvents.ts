/**
 * The runtime event plane (PRD 7.1, C7): the publisher and exhaustive event
 * readers, including the NDJSON projection. Renderers read SessionInputs,
 * which orders this log against the transient text and local levels.
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
  DisplaySessionEvent,
  SessionEventDraft,
} from '@shared/schemas';
import type { DatabaseNotOwner, DatabaseWriteFailed } from './database';

/** A publisher's position in the commit space: what `all` reads from. */
export type SessionCursor = CommitOrdinal;

/**
 * The canonical hostname, pid, and nullable process-start tuple (C5): the
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
    /** Return the committed rows of one ordered transaction (C6), or one of
     *  two typed refusals, both meaning nothing was written (D6 b):
     *  `DatabaseNotOwner`, a target the process does not hold open (the
     *  single-owner race lost, or a closed aggregate), and
     *  `DatabaseWriteFailed`, the batch rolled back for any other reason.
     *  Neither is retried or converted here: a caller that lost its claim
     *  stops and reports, a disk failure surfaces as itself, and neither is
     *  ever read as the other (F3, R7). */
    readonly publish: (
      events: readonly SessionEventDraft[],
    ) => Effect.Effect<
      readonly SessionEvent[],
      DatabaseNotOwner | DatabaseWriteFailed
    >;
    /** The cold listing hydrate (C8): the latest row per aggregate and type
     *  for the listing fact types plus the outstanding approvals, in commit
     *  order; never a transcript row; completes. */
    readonly listing: () => Stream.Stream<DisplaySessionEvent>;
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
    ) => Stream.Stream<DisplaySessionEvent>;
    /** One aggregate's rows from `fromSeq`, in seq order; completes. A
     *  history read, never a tail. */
    readonly aggregate: (
      aggregateId: AggregateId,
      fromSeq: number,
    ) => Stream.Stream<DisplaySessionEvent>;
  }
>()('@texra/session/SessionEvents') {}

export type SessionEventsShape = Context.Service.Shape<typeof SessionEvents>;
