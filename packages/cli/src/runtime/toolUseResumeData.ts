import { Effect } from 'effect';
import { retrieveSessionResumeData, type AgentConfig } from '@agent/runtime';

import { deriveResumability } from '@agent/storage';
import type { SessionHandle } from '@agent/runtime';
import { createLog } from '@logger/logUtils';
import {
  AgentCategory,
  RUN_OUTCOME,
  type FlowSnapshotPayload,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const logger = createLog('CliToolUseResumeData');

/**
 * The durable facts a run's continuability is decided from. `history list`
 * reads them off the listing row it already has; `history show` reads the
 * same ones for the single run it was asked about. One rule, so the frozen
 * `status` contract cannot report two different values for one run.
 */
export interface CliRunResumabilityFacts {
  readonly id: RunId;
  /** A `flow.snapshot` exists on the run aggregate — one indexed read. */
  readonly checkpointPresent: boolean;
  readonly agentCategory?: AgentConfig['agentCategory'];
  readonly outcome?: RunOutcome;
}

/**
 * Whether a snapshot records a compile rejection its run can no longer
 * clear: the last round's compile was rejected and no round is left to fix
 * it, so continuing only replays the same rejection. This is the reflection
 * loop's own terminal-rejection rule, read off the durable snapshot instead
 * of off the loop's in-memory state.
 */
export function snapshotHoldsTerminalCompileRejection(
  snapshot: FlowSnapshotPayload,
): boolean {
  if (snapshot.family !== 'reflection') return false;
  const { state } = snapshot;
  return (
    state.unresolvedCompileRejection === true &&
    state.currentRound + 1 >= state.totalRounds
  );
}

/**
 * Whether the CLI may offer a run as continuable, from facts that cost one
 * indexed snapshot read at most.
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
 * reflection loop writes that marker during the final round, before the run
 * lifecycle records `meta.outcome`, so the terminal outcomes that prove
 * `resolveOutcome` already ran — CANCELLED and COMPLETED, neither of which
 * `deriveRunOutcome` can produce over a terminal rejection — skip the read,
 * while FAILED and a missing outcome are read.
 */
export const isCliRunResumable = Effect.fn('isCliRunResumable')(function* (
  facts: CliRunResumabilityFacts,
  session: SessionHandle,
): Effect.fn.Return<boolean> {
  if (!facts.checkpointPresent) return false;
  if (facts.agentCategory !== AgentCategory.Workflow) return true;
  if (
    facts.outcome === RUN_OUTCOME.CANCELLED ||
    facts.outcome === RUN_OUTCOME.COMPLETED
  ) {
    return true;
  }
  const decision = yield* deriveResumability(facts.id, session);
  if (decision.kind === 'unreadable') {
    // An unreadable run is advertised here and refused at open time, out loud
    // either way.
    logger.warn(
      `Advertising workflow ${facts.id} as resumable without reading its persisted state: ${decision.cause}`,
    );
    return true;
  }
  return (
    decision.kind === 'checkpoint' &&
    !snapshotHoldsTerminalCompileRejection(decision.snapshot)
  );
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
      Effect.sync(() => {
        logger.debug(
          `No resumed model for history entry ${id}: ${toErrorMessage(error)}`,
        );
        return undefined;
      }),
    ),
  );
});
