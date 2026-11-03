/**
 * The session log's shape: the session's doors to its store, on its one
 * publisher (`SessionEvents`), and the reads beside them. The session layer
 * builds it over the store (`sessionStore.ts`); its tag is `SessionLog`
 * (`runHistory.ts`).
 */

import type {
  AggregateId,
  CommitOrdinal,
  DisplaySessionEvent,
  RunEnd,
  RunId,
  RunOutcome,
  SessionEvent,
  SessionEventDraft,
} from '@shared/schemas';
import type { Effect, Scope, Stream, SubscriptionRef } from 'effect';
import type { AgentEvent } from './agentEvent';
import type {
  AggregateClaim,
  DatabaseClaimError,
  DatabaseNotOwner,
  DatabaseReadFailed,
  DatabaseWriteFailed,
  SessionStoreMovedAside,
} from './database';
import type { RunRowRead } from './runRowReads';
import type { RunRows } from './runRowsShape';
import type { RunHistoryDraft } from './runState';
import type { Append, UnfoldedDraft } from './sessionEvents';

/** A streaming row's closing fact, as the run history commits it. */
export type StreamClosure = Extract<RunHistoryDraft, { type: 'stream.end' }>;

/** The facts that close a run's open work: its streams, and with an
 *  outcome its stages too. */
export type ClosureFact =
  StreamClosure | Extract<SessionEventDraft, { type: 'stage.end' }>;

/** A write the store refused: nothing was written. */
export type LogWriteError = DatabaseNotOwner | DatabaseWriteFailed;

/** A claim the store would not give this process. */
export type ClaimError = DatabaseReadFailed | DatabaseClaimError;

/** What one transaction's job holds: the ordered append (each in this
 *  transaction's order) and a registration's claim take-over. What must run
 *  only once it commits goes through {@link SessionLogShape.afterCommit}. */
export interface SessionTransaction {
  readonly append: Append;
  /** Take `runId`'s claim for this process (a dead owner's, proved dead,
   *  or its own) and leave it for the run's driver; given back if the job
   *  fails, or if what it committed never reaches the view. */
  readonly claim: (runId: RunId) => Effect.Effect<void, ClaimError>;
  /** Let `runId`'s claim go with this job's commit: a child whose last turn
   *  waits for a parent another process holds, so whoever delivers it
   *  takes the claim with no owner to prove dead. */
  readonly release: (runId: RunId) => Effect.Effect<void, DatabaseWriteFailed>;
}

/**
 * The session's doors to its store, on its one publisher, and the reads
 * beside them. Every awaited write is one {@link transact} (a run's own rows
 * too, through the session's run history); trace rows go through
 * {@link publish}.
 */
export interface SessionLogShape {
  /** One transaction, run as the next job of the session's publisher and
   *  returned once the view applied it: a batch of rows, or a job that reads
   *  committed rows and appends what depends on them with no other write
   *  between. A refusal wrote nothing, comes back typed, never retried. */
  transact(
    events: readonly UnfoldedDraft[],
  ): Effect.Effect<readonly SessionEvent[], LogWriteError>;
  transact<A, E>(
    job: (tx: SessionTransaction) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | LogWriteError>;
  /** Publish one trace event (display rows only: no {@link AgentEvent} is
   *  part of the run's state) as its row, a chunk as transient text; its order
   *  is this call, a refusal the run's own ({@link lost}). */
  publish(runId: RunId, event: AgentEvent): void;
  /** The first row of `runId` the store refused, taken, as its `run.end`
   *  error. */
  lost(runId: RunId): Effect.Effect<RunEnd['error'] | undefined>;
  /** What closes `runId`'s open streams (and stages, with an `outcome`);
   *  read in a publisher job or after {@link settled}. */
  closure(runId: RunId): StreamClosure[];
  closure(runId: RunId, outcome: RunOutcome): ClosureFact[];
  /** A barrier: every job enqueued before it has run, the view applied it, and
   *  the terminal-result presenter read the view's tail past it. A refused
   *  detached row is heard by its writer. */
  readonly settled: Effect.Effect<void>;
  /** Run `action` once the job this fiber runs (inside {@link transact})
   *  commits, never if it rolls back; outside a job, now. */
  afterCommit(action: Effect.Effect<void>): Effect.Effect<void>;
  /** The current commit ordinal: where a new reader starts its {@link tail}. */
  now(): CommitOrdinal;
  /** A run's history rows, the kinds its state reads, in seq order; with
   *  `fromSeq`, only those from that seq on. */
  history(
    id: AggregateId,
    fromSeq?: number,
  ): Effect.Effect<readonly SessionEvent[], DatabaseReadFailed>;
  /** The `RunRows` of the kinds one read names (`RUN_ROW_READS`), read
   *  through the type index of a run's aggregate or a plugin's own; with
   *  `through`, of its rows up to that seq alone (a fork's cut). */
  runRows(
    id: AggregateId,
    read: RunRowRead,
    through?: number,
  ): Effect.Effect<RunRows, DatabaseReadFailed>;
  /** The strings under `digests`: what the rows name by address (media
   *  bytes, a tool edit's proposal). */
  blobs(
    digests: readonly string[],
  ): Effect.Effect<ReadonlyMap<string, string>, DatabaseReadFailed>;
  /** A run's facts, folded from its latest row of each record type (its
   *  requests and pending input left out: a `runRows` read holds those);
   *  null while the store holds no open run under the id. */
  facts(runId: RunId): Effect.Effect<RunRows | null, DatabaseReadFailed>;
  /** A run's display rows, its priced `usage` rows among them; empty when
   *  the run never existed or was removed. */
  display(
    runId: RunId,
  ): Effect.Effect<readonly DisplaySessionEvent[], DatabaseReadFailed>;
  /** Every display row above `fromCommit` in commit order, then the live
   *  tail. `drained` receives the commit each forward read covered. */
  tail(
    fromCommit: CommitOrdinal,
    drained?: SubscriptionRef.SubscriptionRef<CommitOrdinal>,
  ): Stream.Stream<DisplaySessionEvent, DatabaseReadFailed>;
  /** The cold listing: the latest row per aggregate and listing type, plus
   *  the outstanding approvals; completes. */
  listing(): Stream.Stream<DisplaySessionEvent, DatabaseReadFailed>;
  /** Hold `runId`'s claim for the caller's scope. Holds are counted: the
   *  first takes the claim (proving a prior owner dead), later ones share
   *  it, and the last to go returns it to how the first found it, unless a
   *  hold `ends` it (the run's driver), when it is released. */
  hold(
    runId: RunId,
    options?: { readonly ends?: boolean },
  ): Effect.Effect<void, ClaimError, Scope.Scope>;
  /** Whether this process holds `runId` open in the database: the durable
   *  claim, read from SQLite rather than from the view, which lags. */
  owns(runId: RunId): Effect.Effect<boolean, DatabaseReadFailed>;
  /** Who holds `runId` now, with the owner's liveness proved in the call:
   *  what a resume gate and the run listing word a refusal from. */
  owner(runId: RunId): Effect.Effect<AggregateClaim, DatabaseReadFailed>;
  /** Set when opening the store moved an older build's rows aside; the
   *  host that opened the session presents it once. */
  readonly movedAside: SessionStoreMovedAside | null;
}
