import { Effect } from 'effect';
/**
 * Whether a run is still going, decided from facts that outlive this process.
 *
 * "No handle in this process" is not liveness. A run this shell never
 * launched, one another TeXRA process owns, and one whose owner crashed all
 * look identical from the registry, so a missing handle (or a missing
 * `run.end` row) can never on its own justify telling a model that a run
 * finished — or that it is still running. The ladder below asks the cheapest
 * durable fact that can decide the question, and stops there:
 *
 * 1. a handle in this process — the registry's phase is the live truth;
 * 2. the `run.end` row's outcome — the run recorded how it ended, which is its
 *    own durable fact and outranks a claim this process is merely slow to
 *    release (#8093);
 * 3. the run claim — held by a live foreign owner, or by this process with no
 *    run behind it: nothing terminal may be claimed, and the reason is shown;
 * 4. no owner and no recorded outcome — the run stopped without recording how
 *    it ended: interrupted (a crash, or a host that quit).
 *
 * The claim alone is the liveness authority (R6): single-owner sessions make
 * ownership the fact that says whether anything is still running, and the
 * existence of a `flow.snapshot` says only whether there is something to
 * continue, which is the resume path's question, not this one.
 *
 * The cost is the point: the /executions listing walks this once per row, so
 * it must stay at one metadata read (skipped entirely when the caller already
 * holds the row) and, for a row with no recorded outcome, one claim read. A
 * row that recorded its outcome pays neither.
 */

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { runInSession } from '@agent/runtime/RunContext';
import type { RunStatusInfo } from '@agent/runtime/RunHandle';
import { getRunRecords } from '@agent/storage/runRecords';
import { inspectRunLease } from '@agent/storage/runLease';
import type { LeaseOwnerRecord } from '@agent/storage/leaseOwnerLiveness';
import { createLog } from '@logger/logUtils';
import type { RunId, RunOutcome, RunPhase } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('RunLiveness');

/**
 * What may be said about a run right now. `unsettled` carries a mid-sentence
 * clause naming the fact that forbids a terminal reading, so each surface can
 * word it in its own voice. `settled` carries the recorded outcome, so every
 * surface renders the same durable value.
 */
export type RunLiveness =
  | { readonly kind: 'live'; readonly info: LiveRunStatusInfo }
  | { readonly kind: 'unsettled'; readonly reason: string }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'settled'; readonly outcome: RunOutcome };

/**
 * A tracked run's status line. Its phase is a real one — the registry answers
 * with the stream's phase, never the `unknown` the persisted arms fall back to
 * — so a reader may ask whether it is still in flight.
 */
type LiveRunStatusInfo = RunStatusInfo & { status: RunPhase };

/**
 * The run's recorded outcome as a caller that just read it holds it: `null`
 * when the read found no terminal row. `undefined` (the argument omitted)
 * means the caller has none and this module reads it, so "run present
 * without an outcome" never costs a second read.
 *
 * Only a row read for this same request may be passed: an older snapshot would
 * let two surfaces disagree about how one run ended.
 */
export type KnownRunOutcome = RunOutcome | null;

/** `runLeaseHeldMessage`'s copy, as a clause a sentence can continue with. */
function heldElsewhereReason(owner: LeaseOwnerRecord): string {
  return `held by another TeXRA process (pid ${owner.pid} on ${owner.hostname})`;
}

/**
 * This process holds the claim, tracks no run for it, and no outcome was ever
 * written: the registry and the claim disagree with nothing durable to fall
 * back on, which is a leak to report, never a run to call settled.
 */
const OWNED_HERE_REASON = "held by this process's lease with no live run";

export const resolveRunLiveness = Effect.fn('resolveRunLiveness')(function* (
  runId: RunId,
  session: SessionHandle,
  knownOutcome?: KnownRunOutcome,
): Effect.fn.Return<RunLiveness> {
  const { runs } = session;
  const handle = runs.getHandle(runId);
  if (handle) return { kind: 'live', info: runs.getStatus(handle) };

  return yield* Effect.gen(function* (): Effect.fn.Return<
    RunLiveness,
    unknown
  > {
    const outcome =
      knownOutcome === undefined
        ? ((yield* getRunRecords(session, runId).readRunEnd())?.outcome ?? null)
        : knownOutcome;
    // A recorded outcome is the run's own fact, not the claim's: a finished
    // child untracks its handle and writes the outcome long before its loop
    // releases the run claim, and the parent reads the run inside
    // exactly that window (#8093).
    if (outcome !== null) {
      return { kind: 'settled', outcome };
    }
    const lease = yield* Effect.tryPromise({
      try: () => runInSession(session, () => inspectRunLease(runId)),
      catch: (error) => error,
    });
    if (lease.status === 'held') {
      return { kind: 'unsettled', reason: heldElsewhereReason(lease.owner) };
    }
    if (lease.status === 'owned') {
      log.warn(
        `Run ${runId} holds this process's lease with no tracked run and no recorded outcome; reporting it as unsettled rather than finished`,
      );
      return { kind: 'unsettled', reason: OWNED_HERE_REASON };
    }
    // Nobody owns the run and nothing recorded how it ended: it stopped
    // without finishing.
    return { kind: 'interrupted' };
  }).pipe(
    Effect.catch((error) =>
      Effect.sync((): RunLiveness => {
        const cause = toErrorMessage(error);
        log.warn(`Cannot read the durable facts for run ${runId}: ${cause}`, {
          data: error,
        });
        return {
          kind: 'unsettled',
          reason: `in a state this process cannot read (${cause})`,
        };
      }),
    ),
  );
});
