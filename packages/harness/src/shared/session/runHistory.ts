/**
 * The session's history: the run history, the only reader of
 * run-history-private payloads and the writer of a run's own rows, each
 * through one run's {@link RunCell} (`load` reads, `open` hands out the cell
 * the run's writes go through; a request's decision is appended by the
 * session's requests, `runStateAppend`); the
 * session log it commits through; the view folded from that log; and the
 * history query, the model's SQL over the session's display rows. Beside
 * them, the session's approvals, which every run's gated call reads.
 *
 * Stateless by construction. A cell holds its run's `RunState`, rebuilt
 * from the batches it commits; that is what makes `applyRunRows` the same
 * function on the live path and on resume, and it keeps a session-root
 * service free of per-run mutable cache.
 */
import { Cause, Context, type Effect, Schema } from 'effect';

import { RunIdSchema, type RunId, type SessionRowDraft } from '@shared/schemas';
import { causeChain } from '@utils/errors/errorMessage';
import {
  DatabaseAggregateClosed,
  type DatabaseReadFailed,
  DatabaseRowCorrupt,
  DatabaseRowEarlier,
  DatabaseWriteFailed,
} from './database';
import {
  RunHistoryInconsistent,
  type RunHistoryDraft,
  type RunState,
} from './runState';
import type { Alongside, Append } from './sessionEvents';
import type { ApprovalsWithPermission } from './sessionApprovals';
import type { SessionLogShape } from './sessionLog';
import type { SessionViewAccessShape } from './sessionViewAccess';

/**
 * A refusal the run history itself decided. Database failures are kept OUT of
 * this type: reporting a disk error as a refused run is the silent-
 * degradation defect in a different costume, so `open` and `load` keep
 * them in their error channel beside it.
 *
 * Which arms are reachable, and from where:
 * - `not-owner`: from `RunCell.append`, where the session's log refuses a
 *   closed target as `DatabaseAggregateClosed`, nothing written. It is never
 *   synthesised from any other write failure: a disk error stays a
 *   `DatabaseWriteFailed`. A loop that meets it mid-turn stops with it,
 *   no retry and no second write.
 * - `unsafe-endpoint`: a pre-publish assertion over every durable origin,
 *   the loud restatement of the package's endpoint constraint.
 * - `unprepared-history`: `PreparedHistorySchema` over the history the batch
 *   assembles, at the write boundary of every batch that appends to or
 *   rewrites it, and on cold load.
 * - `inconsistent`: the rows cannot be applied; `cause` says why. From
 *   `load`, and from `RunCell.append` before it publishes: a batch is applied
 *   first and refused with nothing committed, because a published row the
 *   row handlers reject is a run no later `load` can read.
 * - `foreign-protocol`: from a resume's activation, before its rows: a turn
 *   the history replays was recorded on another protocol than the run's
 *   binding speaks now, so no request could replay it.
 * A violated `RunCell.append` precondition is a caller defect
 * (`Effect.die`), not an arm: the loop must not handle it.
 */
export class RunHistoryRefused extends Schema.TaggedError<RunHistoryRefused>()(
  'RunHistoryRefused',
  {
    reason: Schema.Literals([
      'not-owner',
      'unsafe-endpoint',
      'unprepared-history',
      'inconsistent',
      'foreign-protocol',
    ]),
    runId: RunIdSchema,
    detail: Schema.String,
    cause: Schema.optional(RunHistoryInconsistent),
  },
) {
  override get message(): string {
    return `The run history refused a write (${this.reason}): ${this.detail}`;
  }
}

/** A write the store refused: the disk, the run history, or a closed
 *  aggregate. */
type StorageRefusal =
  | DatabaseWriteFailed
  | RunHistoryRefused
  | DatabaseAggregateClosed;

/**
 * The store's refusal anywhere in `cause`, failure or defect. A refused write
 * ends the run whatever failed beside it, so a caller that turns the rest of
 * a cause into a result must look past the first reason `Cause.squash` picks.
 */
export function findStorageRefusal(
  cause: Cause.Cause<unknown>,
): StorageRefusal | undefined {
  for (const reason of cause.reasons) {
    if (Cause.isInterruptReason(reason)) continue;
    const error = Cause.isFailReason(reason) ? reason.error : reason.defect;
    if (
      error instanceof DatabaseWriteFailed ||
      error instanceof RunHistoryRefused ||
      error instanceof DatabaseAggregateClosed
    )
      return error;
  }
  return undefined;
}

/**
 * `refusal` as run `runId` ends with it: a closed aggregate is the run
 * history's `not-owner` refusal; a disk or history refusal is itself.
 */
export function runRefusal(
  runId: RunId,
  refusal: DatabaseAggregateClosed,
): RunHistoryRefused;
export function runRefusal(
  runId: RunId,
  refusal: StorageRefusal,
): DatabaseWriteFailed | RunHistoryRefused;
export function runRefusal(
  runId: RunId,
  refusal: StorageRefusal,
): DatabaseWriteFailed | RunHistoryRefused {
  if (!(refusal instanceof DatabaseAggregateClosed)) return refusal;
  const detail = 'the run aggregate is closed';
  return new RunHistoryRefused({ reason: 'not-owner', runId, detail });
}

/** The same append, every row type allowed: used by the run's cell and the
 *  session's requests (`request.opened`/`decided`) alone. */
export const runStateAppend = (
  append: Append,
): ((events: readonly SessionRowDraft[]) => ReturnType<Append>) =>
  // cast: one function; the narrowing is the type fence, not a runtime one.
  append as never;

/**
 * Why `error`, anywhere down its cause chain, says a run's stored rows
 * cannot be used, or undefined for a failure that may pass (the disk):
 * `earlierBuild`, a row an earlier build wrote; `damaged`, a row
 * that does not decode; `unusable`, rows that decode but cannot be
 * continued (they cannot be applied, the history's rules refuse them, or
 * their turns were recorded on a protocol the run's binding no longer
 * speaks). None of the three heals by trying again.
 */
export const runReadRefusal = (
  error: unknown,
): 'earlierBuild' | 'damaged' | 'unusable' | undefined => {
  for (const cause of causeChain(error)) {
    if (cause instanceof DatabaseRowEarlier) return 'earlierBuild';
    if (cause instanceof DatabaseRowCorrupt) return 'damaged';
    if (
      cause instanceof RunHistoryRefused &&
      (cause.reason === 'inconsistent' ||
        cause.reason === 'unprepared-history' ||
        cause.reason === 'foreign-protocol')
    )
      return 'unusable';
  }
  return undefined;
};

/** What a run cell's commits and re-reads fail with. */
export type CellError =
  | RunHistoryRefused
  | DatabaseWriteFailed
  | DatabaseReadFailed;

/**
 * One run's state holder and the writer of the run's own rows: the opening,
 * every step, tool result and delivery, the input it consumes, a
 * compaction's edit, a model switch and its end all commit through
 * {@link RunCell.append}, and nothing sets the state it holds but what that
 * returns. A request's decision (`request.decided`) is the other writer's:
 * the session's requests append it, and the cell's `refresh` takes it in.
 * One exception to the rest: a run whose stored rows cannot be used
 * ({@link runReadRefusal}) opens no cell, so `endIn`
 * (`agent/storage/runLifecycle.ts`) appends its `run.end` and closing rows
 * straight to the ending transaction, without the halt a cell would write.
 * The loop hands the same cell to the invoker and the
 * dispatch unit, so no run service keeps a copy of the state it commits
 * against.
 */
export interface RunCell {
  readonly runId: RunId;
  /** The state the run continues from. Nothing mirrors it. */
  readonly current: Effect.Effect<RunState>;
  /** The state the cell opened on: what a resume rebuilt from stored rows,
   *  or a fresh run's before its opening batch. */
  readonly opened: RunState;
  /**
   * Commit one batch against the current state and hold the state the batch
   * leaves. Rows that read the state (a step, a tool result, a delivery) are
   * built from the state the batch commits against. Read-append-write is
   * one uninterruptible region under the cell's lock, the wait for the lock
   * included: a tool result queued behind a sibling when the run stops
   * belongs to a tool that already ran, and committing it keeps a resume
   * from running it again. `alongside` decides another aggregate's rows,
   * appended after the batch's in its one append: a child turn's delivery
   * to its parent. Failure of any member commits none.
   *
   * Preconditions, checked before anything is written; a violation is a
   * defect:
   * - a batch on an unopened run carries the `run.position` that opens it,
   *   unless it is empty (a registration alone) or carries the run's end;
   * - a `request.opened` precedes the `failed` attempt that asks it;
   * - a `context.edit` immediately precedes the `model.message` `response`
   *   row that used it, when both are present;
   * - a `model.message` `append` naming `sourceResponse` requires that
   *   response to be the pending one, and its first message to be a tool
   *   group carrying, at each call's ordinal, that call's committed
   *   result (committed before, or earlier in this batch): the canonical
   *   tool message binds results to calls positionally, the run history
   *   keys them by `callId`.
   */
  readonly append: <E = never>(
    rows:
      | readonly RunHistoryDraft[]
      | ((state: RunState) => readonly RunHistoryDraft[]),
    alongside?: Alongside<E>,
  ) => Effect.Effect<RunState, CellError | E>;
  /**
   * Re-read the run under the cell's lock: the state with every row another
   * writer committed (a `request.decided` a surface landed), in commit
   * order, whatever this cell appended since. Applying one such row to the
   * cell's state instead cannot work once a sibling call's result has
   * committed after it.
   */
  readonly refresh: Effect.Effect<
    RunState,
    RunHistoryRefused | DatabaseReadFailed
  >;
}

/** How {@link RunHistory} opens a cell. */
export interface RunOpening<E = never> {
  /**
   * A new run's registration (`run.start` first), decided inside the job
   * of the cell's first append, which it rides: the run exists with what
   * that append writes or not at all.
   */
  readonly registration?: Effect.Effect<readonly SessionRowDraft[]>;
  /**
   * A resume: commit, in one batch, the cancellation of every request the
   * previous launch left unbound and the rows this decides from the stored
   * state (its `run.activate`, the grants it ends, a changed configuration).
   */
  readonly activation?: (
    state: RunState | null,
  ) => Effect.Effect<readonly SessionRowDraft[], E>;
  /**
   * The publisher job the caller is inside: the cell reads the run's rows
   * in that job and appends through its transaction, never a nested one,
   * so the job's other rows and the cell's commit together.
   */
  readonly within?: Append;
}

/** The run history over one session's log. */
export class RunHistory extends Context.Service<
  RunHistory,
  {
    /**
     * Rebuild a run's state from its rows. `null` only when no run history
     * row was applied; a run's input changes no state. Run history rows
     * without an opening `run.position` are corrupt history and fail
     * `inconsistent`, because applying an `attempt` or a `response` to a
     * fresh run is how a paid invocation gets issued twice. Reads the run
     * aggregate in full: the state comes from every row.
     */
    readonly load: (
      run: RunId,
      /** Read only the rows up to this `seq`: the run as it stood there. */
      through?: number,
    ) => Effect.Effect<RunState | null, RunHistoryRefused | DatabaseReadFailed>;
    /**
     * The run's cell, seeded with its stored state (a fresh state when it
     * has none). A resume (`activation`) decides from the stored state
     * before any resume side effect, in the transaction that activates it.
     */
    readonly open: <E = never>(
      run: RunId,
      opening?: RunOpening<E>,
    ) => Effect.Effect<
      RunCell,
      RunHistoryRefused | DatabaseReadFailed | DatabaseWriteFailed | E
    >;
  }
>()('@texra-ai/harness/session/RunHistory') {}

/** The session's approvals: approval policy, prompt lanes and each run's
 *  grants. */
export class Approvals extends Context.Service<
  Approvals,
  ApprovalsWithPermission
>()('@texra-ai/harness/session/Approvals') {}

/** The session log: the session's doors to its store, on its one publisher,
 *  which the run history commits through. */
export class SessionLog extends Context.Service<SessionLog, SessionLogShape>()(
  '@texra-ai/harness/session/SessionLog',
) {}

/** The session's view: the one state every renderer reads, and the local
 *  state it keeps beside the rows. */
export class SessionViewAccess extends Context.Service<
  SessionViewAccess,
  SessionViewAccessShape
>()('@texra-ai/harness/session/SessionViewAccess') {}

/** A correctable query refusal: SQLite's error or the exceeded limit. */
export class HistoryQueryRefused extends Schema.TaggedError<HistoryQueryRefused>()(
  'HistoryQueryRefused',
  {
    reason: Schema.Literals([
      'not-a-read',
      'rejected',
      'timeout',
      'result-too-large',
    ]),
    message: Schema.String,
  },
) {}

/** A store failure: process startup, exit, or rejected history rows. */
export class HistoryQueryFailed extends Schema.TaggedError<HistoryQueryFailed>()(
  'HistoryQueryFailed',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const HistoryCellSchema = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Null,
]);
/** One value of a history query's result row. */
export type HistoryCell = typeof HistoryCellSchema.Type;
/** One page of a history query's result: its columns, its rows (capped), and
 *  whether more exist. */
export const HistoryPageSchema = Schema.Struct({
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(HistoryCellSchema)),
  more: Schema.Boolean,
});
/** {@link HistoryPageSchema}'s value. */
export type HistoryPage = typeof HistoryPageSchema.Type;

/** The session's history query (`executions` `query`): one read over the
 *  session's display rows and runs as of the call, in a store closed with
 *  the session. */
export class HistoryQuery extends Context.Service<
  HistoryQuery,
  {
    readonly query: (
      sql: string,
      params: readonly HistoryCell[],
    ) => Effect.Effect<
      HistoryPage,
      HistoryQueryRefused | HistoryQueryFailed | DatabaseReadFailed
    >;
  }
>()('@texra-ai/harness/session/HistoryQuery') {}
