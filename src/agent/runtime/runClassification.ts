/**
 * One classification of a persisted run, read from disk facts, mutating
 * nothing.
 *
 * In-memory RUNNING/WAITING means exactly "a live flow context exists in this
 * process's registry". Every other run in the shared bucket is one of these,
 * decided once here and never inferred:
 *
 * - `held_elsewhere`: its execution lease is held by an owner that is alive
 *   or cannot be proven dead (another TeXRA process). Shown read-only.
 * - `owned_here`: its lease is held by this very process. Never a restart
 *   candidate; the caller treats reaching it as an invariant violation.
 * - `resumable`: a checkpoint (flow record) exists and nobody alive holds the
 *   lease. Continued only through the explicit Resume affordance.
 * - `finished`: no checkpoint. Its persisted outcome, when present, is the
 *   display fact.
 * - `unclassified`: the lease, metadata, or flow record could not be read or
 *   is malformed. Nothing is known, so nothing is mutated. A present-but-
 *   invalid checkpoint lands here, never in `finished`: corruption is unknown
 *   state, not a terminal run.
 *
 * The first, second, and last kinds are all shown as one unavailable state
 * whose detail is the text of the fact; Delete is the user's only action.
 */
import { inspectExecutionLease } from '@agent/storage/executionLease';
import type { LeaseOwnerRecord } from '@agent/storage/leaseOwnerLiveness';
import {
  deriveResumability,
  type ResumabilityFault,
} from '@agent/storage/resumability';
import { createLog } from '@logger/logUtils';
import type { ExecutionId, RunOutcome } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('RunClassification');

export type RunClassification =
  | { readonly kind: 'held_elsewhere'; readonly owner: LeaseOwnerRecord }
  | { readonly kind: 'owned_here' }
  | { readonly kind: 'resumable'; readonly outcome?: RunOutcome }
  | { readonly kind: 'finished'; readonly outcome?: RunOutcome }
  | {
      readonly kind: 'unclassified';
      readonly cause: string;
      /**
       * Which durable fact was unreadable, when a fact-level probe named one.
       * A caller words a run's refusal from this, never from `cause`, which is
       * display text. Absent when the classification failed above the facts
       * (an unreadable stream index, a lease lock that could not be taken).
       */
      readonly fault?: ResumabilityFault | 'lease-unreadable';
    };

/** What the durable facts alone decide, ownership already settled. */
type RunFactsClassification = Exclude<
  RunClassification,
  { kind: 'held_elsewhere' | 'owned_here' }
>;

/** The one mapping from durable resumability facts to this vocabulary. */
async function classifyRunFacts(
  executionId: ExecutionId,
): Promise<RunFactsClassification> {
  const facts = await deriveResumability(executionId);
  if (facts.kind === 'checkpoint') {
    return { kind: 'resumable', outcome: facts.outcome };
  }
  if (facts.kind === 'none') {
    return { kind: 'finished', outcome: facts.outcome };
  }
  log.warn(`Cannot classify ${executionId}: ${facts.cause}`);
  return { kind: 'unclassified', cause: facts.cause, fault: facts.fault };
}

/** Classify one execution. Never throws: an unreadable fact is `unclassified`. */
export async function classifyRun(
  executionId: ExecutionId,
): Promise<RunClassification> {
  try {
    const lease = await inspectExecutionLease(executionId);
    if (lease.status === 'owned') return { kind: 'owned_here' };
    if (lease.status === 'held') {
      return { kind: 'held_elsewhere', owner: lease.owner };
    }
  } catch (error) {
    const cause = `lease unreadable (${toErrorMessage(error)})`;
    log.warn(`Cannot classify ${executionId}: ${cause}`, { data: error });
    return { kind: 'unclassified', cause, fault: 'lease-unreadable' };
  }
  return classifyRunFacts(executionId);
}
