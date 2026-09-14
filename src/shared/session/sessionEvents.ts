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

/** One ordered append to the log, as the publisher hands it to a job. */
export type Append = (
  events: readonly SessionEventDraft[],
) => Effect.Effect<
  readonly SessionEvent[],
  DatabaseNotOwner | DatabaseWriteFailed
>;

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

/**
 * The one publisher of a root's facts (PRD 7.1, C6). Every write to the
 * log is a job on one inbox drained by one fiber, so the commit order of
 * the table is the order the jobs were enqueued: a trace row the tool
 * emitted, the loop's settlement batch that follows it, and a surface's
 * decision all land in program order, whichever fiber produced them. A job
 * receives the log's `Append` as its one argument and nothing else, so it
 * cannot wait on the publisher it runs on.
 */
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
     *  ever read as the other (F3, R7). The batch is the next job of the
     *  inbox: it commits after every job enqueued before it. */
    readonly publish: (
      events: readonly SessionEventDraft[],
    ) => Effect.Effect<
      readonly SessionEvent[],
      DatabaseNotOwner | DatabaseWriteFailed
    >;
    /** Run one job on the publisher fiber and return its value: a read of
     *  committed rows and the append that depends on it, with no other
     *  write between them. */
    readonly exclusive: <A, E>(
      job: (append: Append) => Effect.Effect<A, E>,
    ) => Effect.Effect<A, E>;
    /** Enqueue one job synchronously and return: the door for a producer
     *  with no fiber to wait on (a trace subscriber, a status transition).
     *  Its order is the moment of this call. A refusal is logged and kept
     *  for the next `settle`; a job enqueued after the plane closed goes
     *  nowhere. */
    readonly detach: (
      job: (
        append: Append,
      ) => Effect.Effect<unknown, DatabaseNotOwner | DatabaseWriteFailed>,
    ) => void;
    /** Wait for every detached job enqueued before this call to run, then
     *  fail with their aggregated refusals, if any; on success, the highest
     *  commit those jobs appended, or null when none appended. */
    readonly settle: Effect.Effect<CommitOrdinal | null, Error>;
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

/** The plane's reads alone: what a holder of a session may do to the log
 *  without publishing (the session publishes; nothing holding one appends
 *  past its bookkeeping). */
export type SessionEventReads = Pick<
  SessionEventsShape,
  'listing' | 'all' | 'aggregate'
>;
