/**
 * The run ledger: the only reader of ledger-private payloads and the only
 * writer of the run rows. Three operations, each a boundary the row design
 * names, each taking the run id and qualifying its own aggregate access with
 * `aggregateId('run', run)`.
 *
 * Stateless by construction. The loop holds the `RunState`; the ledger folds
 * the batch it just committed onto the state it was handed. That is what
 * makes `foldRunState` provably the same function on the live path and on
 * resume, and it keeps a session-root service free of per-run mutable cache.
 *
 * Deliberately absent: no `append` (a one-row case is a one-element batch),
 * no `messages()` (the folded state holds them), no snapshot writer helper
 * (a snapshot is a row like any other), no subscribe surface.
 */
import { Context, Data, type Effect } from 'effect';

import type { RunId, SessionEvent } from '@shared/schemas';
import type { DatabaseReadFailed, DatabaseWriteFailed } from './database';
import type {
  RunLedgerDraft,
  RunLedgerInconsistent,
  RunState,
} from './runStateFold';

/**
 * A refusal the ledger itself decided. Database failures are NOT folded into
 * this type: reporting a disk error as a stolen claim is the silent-
 * degradation defect in a different costume, so `acquire` and `load` keep
 * them in their error channel beside it.
 *
 * Which arms are reachable, and from where (D6 b):
 * - `not-owner`: from `acquire`, where `Database.acquireClaims` proves prior
 *   owners dead before moving the claim and a live foreign owner is the
 *   `DatabaseClaimRefused` verdict it fails with; and from `appendBatch`,
 *   where `SessionEvents.publish` refuses a target this process no longer
 *   holds open as `DatabaseNotOwner`, nothing written. It is never
 *   synthesised from any other write failure: a disk error stays a
 *   `DatabaseWriteFailed` (F3). A loop that meets it mid-turn stops with it,
 *   no retry and no second write (R7).
 * - `unsafe-endpoint`: a pre-publish assertion over every durable origin,
 *   the loud restatement of the package's endpoint constraint (D1).
 * - `unprepared-history`: `PreparedHistorySchema` over the history the batch
 *   assembles, at the write boundary of every batch that appends to or
 *   rewrites it, and on cold load (D11).
 * - `inconsistent`: the rows do not fold; `cause` says why. From `load`, and
 *   from `appendBatch` before it publishes: a batch is folded first and
 *   refused with nothing committed, because a published row the fold rejects
 *   is a run no later `load` can read.
 * A violated `appendBatch` precondition is a caller defect (`Effect.die`),
 * not an arm: the loop must not handle it.
 */
export class RunLedgerRefused extends Data.TaggedError('RunLedgerRefused')<{
  readonly reason:
    'not-owner' | 'unsafe-endpoint' | 'unprepared-history' | 'inconsistent';
  readonly runId: RunId;
  readonly detail: string;
  readonly cause?: RunLedgerInconsistent;
}> {}

export class RunLedger extends Context.Service<
  RunLedger,
  {
    /**
     * The claim gate, called before any resume side effect: resume acquires
     * the run aggregate's current claim first, then calls `load`. Without it
     * a second process can fold a run's state, re-dispatch a barrier tool,
     * and learn only at its first append that the claim never moved, after
     * the side effect.
     */
    readonly acquire: (
      run: RunId,
    ) => Effect.Effect<
      void,
      RunLedgerRefused | DatabaseReadFailed | DatabaseWriteFailed
    >;
    /**
     * Fold a run's rows into its state. `null` only when the run aggregate
     * carries no ledger row: the loop's fresh-run branch and, for a run
     * recorded before the run ledger, the honest answer, distinct from
     * "checkpoint corrupt". Ledger rows without an opening `flow.snapshot`
     * are not that case: they are a malformed aggregate and fail
     * `inconsistent`, because folding an `attempt` or a `response` into a
     * fresh run is how a paid invocation gets issued twice. Reads the run
     * aggregate in full: a `flow.snapshot` carries no reference to the
     * message history below it (D5 dropped `messageBaseCommit`), so a fold
     * anchored at the latest snapshot would restore a run with no
     * conversation and no error to say so.
     */
    readonly load: (
      run: RunId,
    ) => Effect.Effect<RunState | null, RunLedgerRefused | DatabaseReadFailed>;
    /**
     * The latest `flow.snapshot` on the run aggregate, one indexed row read
     * and no fold: what every reader of the retired `flow_<id>.json` becomes.
     * `null` when the run has never written one, or is closed. Existence,
     * `payload.family`, and `payload.runtime` (phase, coordinates, model id,
     * compatibility key) are the facts it answers; a run's state is `load`.
     */
    readonly latestSnapshot: (
      run: RunId,
    ) => Effect.Effect<
      Extract<SessionEvent, { type: 'flow.snapshot' }> | null,
      DatabaseReadFailed
    >;
    /**
     * Commit one ordered batch in one transaction, and return the state the
     * loop continues from: `state` folded with the rows the publisher
     * actually committed. Failure of any member commits none.
     *
     * Preconditions, checked before publish; a violation is a defect:
     * - a `flow.snapshot` is the last ledger row of its batch, except when a
     *   `flow.step`, a companion `tool.end`, a `request.decided`, or the
     *   `stream.end` closing the row a `waiting` step parks beside follows
     *   it. A `request.opened` PRECEDES the snapshot that binds it: the
     *   snapshot is its recovery binding and the fold resolves that binding
     *   against the requests already folded;
     * - a `model.compaction` immediately precedes the `model.message`
     *   `response` row that used it, when both are present;
     * - a `model.message` `response` row carries the dispatch facts and the
     *   priced `usage` of its turn, both stamped here: the package produces
     *   neither a dispatch partition nor a price, and `RunState.usage` is
     *   derived from the rows alone (D12), so a row appended without its
     *   `NormalizedUsage` silently loses that turn's cost on resume;
     * - a `model.message` `append` naming `sourceResponse` requires that
     *   response to be the current pending response, and its first message
     *   to be a tool group carrying, at the `callOrdinal` of each of that
     *   response's dispatch facts, the committed settlement for that
     *   `callId` (committed before, or earlier in this batch). This is the
     *   settlement-to-provider join: the canonical tool message binds
     *   results to calls positionally, the ledger keys them by `callId`.
     */
    readonly appendBatch: (
      run: RunId,
      state: RunState | null,
      rows: readonly RunLedgerDraft[],
    ) => Effect.Effect<RunState, RunLedgerRefused | DatabaseWriteFailed>;
  }
>()('@texra/session/RunLedger') {}
