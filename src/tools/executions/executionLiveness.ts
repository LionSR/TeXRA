/**
 * Whether a run is still going, decided from facts that outlive this process.
 *
 * "No handle in this process" is not liveness. A run this shell never
 * launched, one another TeXRA process owns, and one whose owner crashed all
 * look identical from the registry, so a missing handle (or a missing
 * `meta.outcome`) can never on its own justify telling a model that a run
 * finished — or that it is still running. The ladder below asks the cheapest
 * durable fact that can decide the question, and stops there:
 *
 * 1. a handle in this process — the registry's phase is the live truth;
 * 2. a persisted `meta.outcome` — the run recorded how it ended, which is its
 *    own durable fact and outranks a lease this process is merely slow to
 *    release (#8093);
 * 3. a lease a live foreign owner holds, or one this process holds with no run
 *    behind it — nothing terminal may be claimed, and the reason is shown;
 * 4. no checkpoint on disk — nothing is left to continue and nothing recorded
 *    an outcome, so the reading is settled with none ("unknown");
 * 5. a checkpoint nobody holds — the run was interrupted (a crash, or a host
 *    that quit).
 *
 * Ownership is asked before the checkpoint because a checkpoint is an agent
 * run's artifact. A background shell and a workflow-script container hold an
 * execution lease for their whole lifetime and never write `flow_<id>.json`,
 * so statting first would read a live run another TeXRA process owns as
 * settled with no outcome.
 *
 * The cost is the point: the /executions listing walks this once per row, so
 * it must stay at one metadata read (skipped entirely when the caller already
 * holds the row) and, for a row with no recorded outcome, one lease read plus
 * — only when that lease is free — one `exists` stat. A row that recorded its
 * outcome pays neither.
 *
 * Checkpoint *validity* is therefore deliberately not re-derived here.
 * `deriveResumability` parses the record and is stricter than a stat (a spent
 * cursor, a malformed record, or one written by a newer TeXRA is not a
 * checkpoint to promise anyone), but parsing 200 flow records to fill a status
 * column is exactly the cost this surface must not pay. A malformed checkpoint
 * consequently reads as interrupted here; the single-run resume path that
 * would act on one parses it and refuses loudly.
 */

import { flowKey } from '@agent/node/persistedFlow';
import { currentSession } from '@agent/runtime/SessionHandle';
import type { ExecutionStatusInfo } from '@agent/runtime/ExecutionHandle';
import { getExecutionStore } from '@agent/storage/ExecutionKVStore';
import { inspectExecutionLease } from '@agent/storage/executionLease';
import type { LeaseOwnerRecord } from '@agent/storage/leaseOwnerLiveness';
import { createLog } from '@logger/logUtils';
import type {
  ExecutionId,
  ExecutionMeta,
  RunOutcome,
  StreamPhase,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('ExecutionLiveness');

/**
 * What may be said about a run right now. `unsettled` carries a mid-sentence
 * clause naming the fact that forbids a terminal reading, so each surface can
 * word it in its own voice. `settled` carries the recorded outcome, so every
 * surface renders the same durable value.
 */
export type ExecutionLiveness =
  | { readonly kind: 'live'; readonly info: LiveExecutionStatusInfo }
  | { readonly kind: 'unsettled'; readonly reason: string }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'settled'; readonly outcome?: RunOutcome };

/**
 * A tracked run's status line. Its phase is a real one — the registry answers
 * with the stream's phase, never the `unknown` the persisted arms fall back to
 * — so a reader may ask whether it is still in flight.
 */
type LiveExecutionStatusInfo = ExecutionStatusInfo & { status: StreamPhase };

/**
 * The execution's metadata row as a caller that just read it holds it: `null`
 * when the read found none. `undefined` (the argument omitted) means the
 * caller has none and this module reads it, so "row present without an
 * outcome" never costs a second read.
 *
 * Only a row read for this same request may be passed: an older snapshot would
 * let two surfaces disagree about how one run ended.
 */
export type KnownExecutionMeta = Pick<ExecutionMeta, 'outcome'> | null;

/** `executionHeldMessage`'s copy, as a clause a sentence can continue with. */
function heldElsewhereReason(owner: LeaseOwnerRecord): string {
  return `held by another TeXRA process (pid ${owner.pid} on ${owner.hostname})`;
}

/**
 * This process holds the lease, tracks no run for it, and no outcome was ever
 * written: the registry and the lease disagree with nothing durable to fall
 * back on, which is a leak to report, never a run to call settled.
 */
const OWNED_HERE_REASON = "held by this process's lease with no live run";

export async function resolveExecutionLiveness(
  executionId: ExecutionId,
  knownMeta?: KnownExecutionMeta,
): Promise<ExecutionLiveness> {
  const { executions } = currentSession();
  const handle = executions.getHandle(executionId);
  if (handle) return { kind: 'live', info: executions.getStatus(handle) };

  const store = getExecutionStore(executionId);
  try {
    const meta = knownMeta === undefined ? await store.readMeta() : knownMeta;
    // A recorded outcome is the run's own fact, not the lease's: a finished
    // child untracks its handle and writes the outcome long before its loop
    // releases the execution lease, and the parent reads the run inside
    // exactly that window (#8093).
    if (meta?.outcome !== undefined) {
      return { kind: 'settled', outcome: meta.outcome };
    }
    const lease = await inspectExecutionLease(executionId);
    if (lease.status === 'held') {
      return { kind: 'unsettled', reason: heldElsewhereReason(lease.owner) };
    }
    if (lease.status === 'owned') {
      log.warn(
        `Execution ${executionId} holds this process's lease with no tracked run and no recorded outcome; reporting it as unsettled rather than finished`,
      );
      return { kind: 'unsettled', reason: OWNED_HERE_REASON };
    }
    // Nobody owns the run: a checkpoint left behind is one that stopped
    // without finishing, and none at all leaves nothing to continue.
    return (await store.exists(flowKey(executionId)))
      ? { kind: 'interrupted' }
      : { kind: 'settled' };
  } catch (error) {
    const cause = toErrorMessage(error);
    log.warn(
      `Cannot read the durable facts for execution ${executionId}: ${cause}`,
      { data: error },
    );
    return {
      kind: 'unsettled',
      reason: `in a state this process cannot read (${cause})`,
    };
  }
}
