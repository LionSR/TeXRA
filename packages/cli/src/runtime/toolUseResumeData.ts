import { Effect } from 'effect';
import { retrieveSessionResumeData, type AgentConfig } from '@agent/runtime';

import { deriveResumability } from '@agent/storage';
import type { SessionHandle } from '@agent/runtime';
import { withLogChannel } from '@logger/effectLog';
import {
  AgentCategory,
  HISTORY_RUN_STATUS,
  isTerminalCompileRejection,
  RUN_OUTCOME,
  type HistoryRunStatus,
  type RunId,
  type RunLifecycleStatus,
} from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'CliToolUseResumeData';

/**
 * The durable facts a run's standing is decided from. `history list` reads
 * them off the listing row it already has; `history show` reads the same ones
 * for the single run it was asked about. One rule, so the frozen `status`
 * contract cannot report two different values for one run.
 */
export interface CliRunFacts {
  readonly id: RunId;
  /** A `flow.snapshot` exists on the run aggregate — one indexed read. */
  readonly checkpointPresent: boolean;
  /** Null when the run has no readable config: there is no category to
   *  resume under and no config for a host to adopt, so it is not offered. */
  readonly agentCategory: AgentConfig['agentCategory'] | null;
  /** The run's folded status; a terminal outcome phase is its durable
   *  outcome, anything else means no outcome has landed. */
  readonly phase?: RunLifecycleStatus;
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
 * rejection has a snapshot that only replays the same rejection. The
 * reflection loop writes that marker during the final round, before
 * `finalizeRun` writes the `run.end` row, so the terminal outcomes that prove
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
        !(
          decision.snapshot.family === 'reflection' &&
          isTerminalCompileRejection(
            decision.snapshot.state,
            decision.snapshot.runtime.round,
          )
        );
    }
  }
  const status =
    resumable && (outcome === undefined || outcome === RUN_OUTCOME.CANCELLED)
      ? HISTORY_RUN_STATUS.RESUMABLE
      : (outcome ?? HISTORY_RUN_STATUS.UNKNOWN);
  return { status, resumable };
});

/**
 * The model a resume of this run would actually use. A tool-use session that
 * was switched to another model records that only inside its checkpoint, so
 * `history show` parses it — one parse for the one run asked about — while a
 * listing reports the model the run started under.
 *
 * Never throws: a checkpoint that cannot be loaded has no model to report, and
 * refusing such a run is the open path's job, not this row's.
 */
export const readCliResumedModel = Effect.fn('readCliResumedModel')(function* (
  session: SessionHandle,
  id: RunId,
  config: AgentConfig,
): Effect.fn.Return<string | undefined> {
  return yield* retrieveSessionResumeData(id, config, session).pipe(
    Effect.map((resume) =>
      resume?.type === 'toolUse' ? resume.agentConfig.model : undefined,
    ),
    Effect.catch((error) =>
      Effect.logDebug(
        `No resumed model for history entry ${id}: ${toErrorMessage(error)}`,
      ).pipe(withLogChannel(CHANNEL), Effect.as(undefined)),
    ),
  );
});
