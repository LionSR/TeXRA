/**
 * The runtime event plane: the publisher, what it publishes as each job
 * commits, and the exhaustive event readers, including the NDJSON
 * projection. Renderers read SessionInputs, which orders this log against
 * the transient text and local levels.
 */
import {
  Context,
  type Effect,
  type PubSub,
  type Scope,
  type Stream,
  type SubscriptionRef,
  type Take,
} from 'effect';

import type {
  AggregateId,
  CommitOrdinal,
  SessionRow,
  DisplayRow,
  SessionRowDraft,
} from '@shared/schemas';
import type {
  RunChanged,
  DatabaseAggregateClosed,
  DatabaseReadFailed,
  DatabaseWriteFailed,
} from './database';
import type { RunStateRowType } from './runState';
import type { WithBlobs } from './historyTurns';

/** A stream a run's rows left open (`SessionEvents.openWork`). */
export interface OpenWork {
  readonly id: string;
}

/** One committed job as the publisher publishes it: its display rows, as
 *  a display read of the store returns them, and the commit it reached. */
export interface CommittedBatch {
  readonly rows: readonly DisplayRow[];
  readonly through: CommitOrdinal;
}

/** Whether this fiber runs a publisher job: one that opened another would
 *  publish the inner job's rows before its own transaction committed. */
export const InPublisherJob = Context.Reference<boolean>(
  '@texra-ai/harness/session/InPublisherJob',
  { defaultValue: () => false },
);

/** `failed` hears a detached job's own failure, a failed commit's
 *  included. */
export interface JobOptions {
  readonly failed?: (error: unknown) => void;
}

/** A row that is not part of any run's state, or a run's end, which nothing
 *  continues from until the next open folds it: any job may append it as
 *  is, with the blobs it stores. */
export type UnfoldedDraft = WithBlobs<
  Exclude<
    SessionRowDraft,
    { type: Exclude<RunStateRowType, 'run.end' | 'run.stop'> }
  >
>;

/** Rows another owner decides inside a job, appended with the job's own
 *  batch so both commit or neither. */
export type Alongside<E = never> = Effect.Effect<
  readonly UnfoldedDraft[],
  E,
  Scope.Scope
>;

/** One ordered append to the log, as the publisher hands it to a job: a
 *  savepoint of the job's one transaction. A row that is part of a run's
 *  state goes through `runStateAppend` instead, which only the run's cell
 *  (`RunCell.append`) and the session's requests hold. */
export type Append = (
  events: readonly UnfoldedDraft[],
) => Effect.Effect<
  readonly SessionRow[],
  DatabaseAggregateClosed | DatabaseWriteFailed
>;

/**
 * The one publisher of a root's facts. Every write to the log is a job that
 * runs where it is called, as one uninterrupted turn, so the commit order
 * of the table is the order of the calls: a trace row the tool emitted, the
 * loop's result batch that follows it, and a surface's decision all land in
 * program order, whichever fiber produced them. A job receives the log's
 * `Append` and writes through it; one that opens another publication is a
 * defect.
 */
export class SessionEvents extends Context.Service<
  SessionEvents,
  {
    /** Run one job now, as one SQLite transaction, and return its value
     *  with the last commit it made
     *  (`through`, null for a job that appended nothing): reads of committed
     *  rows and the appends that depend on them, committed together or not
     *  at all, with no other write between them. An append refusal is one of two typed
     *  failures: `DatabaseAggregateClosed`, a target the process does not
     *  hold open, and `DatabaseWriteFailed`, the batch rolled back for any
     *  other reason; a job that lets one through writes nothing, and a
     *  transaction that fails to commit is `DatabaseWriteFailed` too.
     *  Neither is retried or converted here. A job is database-only: it
     *  awaits nothing, which is what keeps the transaction one turn.
     *  Called from inside a job, it is a defect. */
    readonly transact: <A, E>(
      job: (append: Append) => Effect.Effect<A, E>,
    ) => Effect.Effect<
      { readonly value: A; readonly through: CommitOrdinal | null },
      E | DatabaseWriteFailed
    >;
    /** Run one job synchronously and return: the door for a producer with
     *  no fiber to wait on (a trace sink, a follow-up's admission). The job
     *  has committed, or failed, when the call returns. A refused append is
     *  never retried: the job hears it, `failed` hears the job's own
     *  failure (a run's trace keeps either for the run's end,
     *  `RunTrace.lost`), and the publisher logs it. A job given after the
     *  plane closed goes nowhere, and says so. */
    readonly detach: (
      job: (
        append: Append,
      ) => Effect.Effect<
        unknown,
        DatabaseAggregateClosed | DatabaseReadFailed | DatabaseWriteFailed
      >,
      options?: JobOptions,
    ) => void;
    /** Remove a run and its dependents: the deletion's transaction is a
     *  job like any other, so what this publisher tracks forgets every run
     *  it names. */
    readonly removeRun: (
      id: AggregateId,
      expectedStartCommit: CommitOrdinal,
    ) => Effect.Effect<
      readonly SessionRow[],
      DatabaseAggregateClosed | RunChanged | DatabaseWriteFailed
    >;
    /** Close the plane: no publication is taken after it. Nothing is left
     *  to wait for, every job having finished in its own call. Idempotent;
     *  the publisher's scope closes it too. */
    readonly close: Effect.Effect<void>;
    /** The streams this publisher committed open on one aggregate and
     *  nothing has closed since, in first-appearance order: each until its
     *  `stream.end` or a phase move that pauses or ends its run. What a
     *  run's wait or end closes. It counts every job that has returned. */
    readonly openWork: (aggregateId: AggregateId) => readonly OpenWork[];
    /** The last commit this publisher published; the store's commit when
     *  it opened, before any. Where a reader that starts now begins. */
    readonly head: () => CommitOrdinal;
    /** Subscribe, for the caller's scope, to every job committed from here
     *  on, one batch per job in commit order, published from what the job
     *  wrote (nothing is read back); it ends (a final `Take`) when the
     *  publisher closes. A subscriber that must not miss a batch subscribes
     *  before it reads {@link head}. */
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<Take.Take<CommittedBatch>>,
      never,
      Scope.Scope
    >;
    /** Every event with commit above `fromCommit`, in commit order across
     *  aggregates, then the tail, which ends when the session closes: what
     *  the reader starts behind {@link head} is read from the store, the rest
     *  is the publisher's batches. Transcript rows of unsubscribed
     *  aggregates included: the live tail and the frozen NDJSON projection
     *  read it.
     *  `drained`, when given, receives the commit each read or batch
     *  covered, rows it could not materialize included, once every row of
     *  it has reached the reader; the transport plane never sets it. */
    readonly all: (
      fromCommit: CommitOrdinal,
      drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
    ) => Stream.Stream<DisplayRow, DatabaseReadFailed>;
  }
>()('@texra-ai/harness/session/SessionEvents') {}

export type SessionEventsShape = Context.Service.Shape<typeof SessionEvents>;
