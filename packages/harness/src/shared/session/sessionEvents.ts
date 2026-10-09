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
import type {
  DatabaseNotOwner,
  DatabaseReadFailed,
  DatabaseWriteFailed,
  DeletionMode,
} from './database';

/** One piece of work a run's rows left open (`SessionEvents.openWork`). */
export interface OpenWork {
  readonly kind: 'stage' | 'stream';
  readonly id: string;
}

/** Whether this fiber runs a publisher job: inside one, the store's write
 *  lock is held, so a claim is the job's own and a wait on the publisher
 *  would never end. */
export const InPublisherJob = Context.Reference<boolean>(
  '@texra/session/InPublisherJob',
  { defaultValue: () => false },
);

/** One ordered append to the log, as the publisher hands it to a job: a
 *  savepoint of the job's one transaction. */
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
    /** Run one job as the next transaction of the inbox, one SQLite
     *  transaction, and return its value: reads of committed rows and the
     *  appends that depend on them, committed together or not at all, with
     *  no other write between them. An append refusal is one of two typed
     *  failures (D6 b): `DatabaseNotOwner`, a target the process does not
     *  hold open, and `DatabaseWriteFailed`, the batch rolled back for any
     *  other reason; a job that lets one through writes nothing, and a
     *  transaction that fails to commit is `DatabaseWriteFailed` too.
     *  Neither is retried or converted here (F3, R7). A job may run again
     *  whole (`Database.job`), so it is database-only. Called from inside
     *  a job, it is a defect: the job would wait on itself. */
    readonly transact: <A, E>(
      job: (append: Append) => Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | DatabaseWriteFailed>;
    /** Enqueue one job synchronously and return: the door for a producer
     *  with no fiber to wait on (a trace sink, a follow-up's admission).
     *  Its order is the moment of this call. A refused append is never
     *  retried: the job hears it (a run's trace keeps it for the run's end,
     *  `RunTrace.lost`), and the publisher logs it as itself. A
     *  job enqueued after the plane closed goes nowhere, and says so. */
    readonly detach: (
      job: (
        append: Append,
      ) => Effect.Effect<
        unknown,
        DatabaseNotOwner | DatabaseReadFailed | DatabaseWriteFailed
      >,
    ) => void;
    /** Remove a run and its dependents (C9) as the next job, so the
     *  tombstone commits in enqueue order and what this publisher tracks
     *  forgets every run it names. */
    readonly removeRun: (
      id: AggregateId,
      mode: DeletionMode,
      expectedStartCommit: CommitOrdinal,
    ) => Effect.Effect<readonly SessionEvent[], DatabaseWriteFailed>;
    /** Close the plane: end the inbox and run what it holds, inside the
     *  one close deadline (`SESSION_CLOSE_DEADLINE_MS`). At the deadline
     *  the running job is cut outside its atomic write and every queued
     *  one is refused, never joined without limit. Idempotent; the
     *  publisher's scope runs it too. */
    readonly drain: Effect.Effect<void>;
    /** What this publisher committed open on one aggregate and nothing has
     *  closed since, in first-appearance order: a stream until its
     *  `stream.end` or a phase move that rests or ends its run, a stage
     *  until its `stage.end`. What a park (streams) or a host exit (both)
     *  closes. Read on the publisher fiber (inside a job) or after a
     *  settle, it counts every job committed before. */
    readonly openWork: (aggregateId: AggregateId) => readonly OpenWork[];
    /** The cold listing hydrate (C8): the latest row per aggregate and type
     *  for the listing fact types plus the outstanding approvals, in commit
     *  order; never a transcript row; completes. */
    readonly listing: () => Stream.Stream<
      DisplaySessionEvent,
      DatabaseReadFailed
    >;
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
    ) => Stream.Stream<DisplaySessionEvent, DatabaseReadFailed>;
  }
>()('@texra/session/SessionEvents') {}

export type SessionEventsShape = Context.Service.Shape<typeof SessionEvents>;
