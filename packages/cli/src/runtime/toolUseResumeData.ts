import { Effect } from 'effect';
import type { AgentConfig } from '@agent/runtime';

import { deriveResumability } from '@agent/storage';
import type { SessionHandle } from '@agent/runtime';
import { withLogChannel } from '@logger/effectLog';
import {
  AgentCategory,
  HISTORY_RUN_STATUS,
  RUN_OUTCOME,
  type HistoryRunStatus,
  type RunId,
  type RunLifecycleStatus,
} from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';

const CHANNEL = 'CliToolUseResumeData';

/**
 * The durable facts a run's standing is decided from. `history list` reads
 * them off the listing row it already has; `history show` reads the same ones
 * for the single run it was asked about. One rule, so the frozen `status`
 * contract cannot report two different values for one run.
 */
export interface CliRunFacts {
  readonly id: RunId;
  /** A `run.snapshot` exists on the run aggregate — one indexed read. */
  readonly checkpointPresent: boolean;
  /** Null when the run has no readable config: there is no category to
   *  resume under and no config for a host to adopt, so it is not offered. */
  readonly agentCategory: AgentConfig['agentCategory'] | null;
  /** The run's folded status; a terminal outcome phase is its durable
   *  outcome, anything else means no outcome has landed. */
  readonly phase?: RunLifecycleStatus;
  /** A stop rested the run instead of ending it (a paused child). */
  readonly paused?: boolean;
}

/** A run's CLI history standing: the frozen `status` and the `resumable`
 *  boolean beside it. */
export interface CliRunStanding {
  readonly status: HistoryRunStatus;
  readonly resumable: boolean;
}

/**
 * Whether the CLI may offer a run as continuable, from facts that cost one
 * indexed snapshot read at most, and the frozen history `status` that follows
 * from it.
 *
 * Ownership is deliberately not inspected. A run another process is executing
 * right now has a snapshot and no outcome, so it is offered here and refused
 * when the user opens it: one lease read on the run they picked instead of one
 * per row. Content is not judged here either — `RunLedger.load` refuses rows
 * that do not fold, and that cohort is worded `unusable_checkpoint` at open
 * time.
 *
 * The one exception buys back a refusal the user would otherwise be walked
 * into: a workflow that stopped at its round cap on an unresolved compile
 * rejection has a snapshot that only replays the same rejection
 * ({@link isTerminalWorkflowCheckpoint}, the rule the interrupt hint reads
 * too). The loop decides it before `finalizeRun` writes the `run.end` row,
 * so the terminal outcomes that prove
 * `resolveOutcome` already ran — CANCELLED and COMPLETED, neither of which
 * `deriveRunOutcome` can produce over a terminal rejection — skip the read,
 * while FAILED and a missing outcome are read.
 *
 * `status` is a frozen contract (the NDJSON stream is consumed by
 * texra-action): a checkpoint promotes only an interrupted or outcome-less
 * run to `resumable`. A failed run that kept its checkpoint still reports
 * `failed`; whether it can be resumed is the sibling `resumable` boolean.
 * An outcome-less run that is not resumable reports `unknown`: nothing
 * classifies every historical run at startup, and a run another process is
 * executing right now is equally outcome-less, so it cannot be guessed here.
 */
export const cliRunStanding = Effect.fn('cliRunStanding')(function* (
  facts: CliRunFacts,
  session: SessionHandle,
): Effect.fn.Return<CliRunStanding> {
  // A paused child is continued by its parent's model, never by `resume`.
  if (facts.paused)
    return { status: HISTORY_RUN_STATUS.PAUSED, resumable: false };
  const outcome = isTerminalOutcomePhase(facts.phase) ? facts.phase : undefined;
  let resumable = facts.agentCategory !== null && facts.checkpointPresent;
  if (
    resumable &&
    facts.agentCategory === AgentCategory.Workflow &&
    outcome !== RUN_OUTCOME.CANCELLED &&
    outcome !== RUN_OUTCOME.COMPLETED
  ) {
    const decision = yield* deriveResumability(facts.id, session);
    if (decision.kind === 'unreadable') {
      // An unreadable run is advertised here and refused at open time, out
      // loud either way.
      yield* Effect.logWarning(
        `Advertising workflow ${facts.id} as resumable without reading its persisted state: ${decision.cause}`,
      ).pipe(withLogChannel(CHANNEL));
    } else {
      resumable =
        decision.kind === 'checkpoint' &&
        !(yield* isTerminalWorkflowCheckpoint(facts.id, session));
    }
  }
  const status =
    resumable && (outcome === undefined || outcome === RUN_OUTCOME.CANCELLED)
      ? HISTORY_RUN_STATUS.RESUMABLE
      : (outcome ?? HISTORY_RUN_STATUS.UNKNOWN);
  return { status, resumable };
});

/**
 * Whether a workflow checkpoint only replays a terminal compile rejection:
 * the last round's compile was rejected and no round is left to fix it. The
 * rows carry no such marker: the loop concluded (`halted`, its last round
 * closed) with no model failure, and its own `halted` position says FAILED,
 * which only the rejection leaves (output finalization's verdict is
 * `run.end`'s, not the loop's). Rows that cannot be read or folded leave the
 * run offered, and refused at open time like any unreadable run.
 */
export const isTerminalWorkflowCheckpoint = Effect.fn(
  'isTerminalWorkflowCheckpoint',
)(function* (id: RunId, session: SessionHandle): Effect.fn.Return<boolean> {
  const state = yield* session.ledger.load(id).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `Advertising workflow ${id} as resumable without its loop verdict: ${error.message}`,
      ).pipe(withLogChannel(CHANNEL), Effect.as(null)),
    ),
  );
  return (
    state !== null &&
    state.phase === 'halted' &&
    state.lastError === null &&
    state.outcome === RUN_OUTCOME.FAILED
  );
});
