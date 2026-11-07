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
import type { Effect, Stream, SubscriptionRef } from 'effect';
import type { AgentEvent } from './agentEvent';
import type {
  DatabaseAggregateClosed,
  DatabaseReadFailed,
  DatabaseWriteFailed,
  SessionStoreMovedAside,
} from './database';
import type { RunRowRead, RunRowsRead } from './runRowReads';
import type { RunRows } from './runRowsShape';
import type { RunHistoryDraft } from './runState';
import type { Append, UnfoldedDraft } from './sessionEvents';

/** A streaming row's closing fact, as the run history commits it. */
export type StreamClosure = Extract<RunHistoryDraft, { type: 'stream.end' }>;

/** The facts that close a run's open work: its streams, and with an
 *  outcome its stages too. */
export type ClosureFact =
  | StreamClosure
  | Extract<SessionEventDraft, { type: 'stage.end' }>;

/** A write the store refused: nothing was written. */
export type LogWriteError = DatabaseAggregateClosed | DatabaseWriteFailed;

/** What one transaction's job holds: the ordered append (each in this
 *  transaction's order). What must run only once it commits runs after
 *  the transaction returns. */
export interface SessionTransaction {
  readonly append: Append;
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
  /** The current commit ordinal: where a new reader starts its {@link tail}. */
  now(): CommitOrdinal;
  /** A run's history rows, the kinds its state reads, in seq order; with
   *  `fromSeq`, only those from that seq on; with `types`, those kinds
   *  instead (what one input became: `RECEIPT_ROW_TYPES`). */
  history(
    id: AggregateId,
    fromSeq?: number,
    types?: readonly SessionEvent['type'][],
  ): Effect.Effect<readonly SessionEvent[], DatabaseReadFailed>;
  /** What one read (`RUN_ROW_READS`) makes of the rows of its kinds, read
   *  through the type index of a run's aggregate or a plugin's own; with
   *  `through`, of its rows up to that seq alone (a fork's cut). */
  runRows<R extends RunRowRead>(
    id: AggregateId,
    read: R,
    through?: number,
  ): Effect.Effect<RunRowsRead<R>, DatabaseReadFailed>;
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
  /** Set when opening the store moved an older build's rows aside; the
   *  host that opened the session presents it once. */
  readonly movedAside: SessionStoreMovedAside | null;
}
