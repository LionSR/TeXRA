import {
  hasTerminalPersistedCompileRejection,
  retrieveSessionResumeData,
  type AgentConfig,
} from '@agent/runtime';
import { getExecutionStore } from '@agent/storage';
import { createLog } from '@logger/logUtils';
import {
  AgentCategory,
  RUN_OUTCOME,
  type ExecutionId,
  type RunOutcome,
  type StreamTabId,
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
  readonly id: ExecutionId;
  /** A checkpoint file exists on disk — one `stat`, never a parse. */
  readonly checkpointPresent: boolean;
  /**
   * The stream stamped on metadata at registration: the reproduction
   * contract, without which there is no persisted stream to continue.
   */
  readonly streamId?: StreamTabId;
  readonly agentCategory?: AgentConfig['agentCategory'];
  readonly outcome?: RunOutcome;
}

/**
 * Whether the CLI may offer a run as continuable, from facts that cost a
 * `stat` at most.
 *
 * Ownership is deliberately not inspected. A run another process is executing
 * right now has a checkpoint and no outcome, so it is offered here and refused
 * when the user opens it: one lease read on the run they picked instead of one
 * per row. Loadability is not inspected either — a checkpoint that exists but
 * cannot be parsed is refused at open time as `unusable_checkpoint`, which is
 * what that cohort actually is.
 *
 * The one exception buys back a refusal the user would otherwise be walked
 * into: a workflow that stopped at its round cap on an unresolved compile
 * rejection has a checkpoint that only replays the same rejection. Reading it
 * is a full Zod parse, so it runs only where such a rejection can have been
 * recorded — `resolveOutcome` feeds `deriveRunOutcome` with `failed` ahead of
 * `cancelled`, so a terminal rejection always finalizes the run FAILED. A
 * cancelled or still-outcome-less workflow row, which is what people resume,
 * costs one stat like every other row.
 */
export async function isCliRunResumable(
  facts: CliRunResumabilityFacts,
): Promise<boolean> {
  if (!facts.checkpointPresent || !facts.streamId) return false;
  if (facts.agentCategory !== AgentCategory.Workflow) return true;
  if (facts.outcome !== RUN_OUTCOME.FAILED) return true;
  try {
    return !(await hasTerminalPersistedCompileRejection(facts.id));
  } catch (error) {
    logger.warn(
      `Not advertising workflow ${facts.id} as resumable: its persisted state is unreadable: ${toErrorMessage(error)}`,
      { data: error },
    );
    return false;
  }
}

/**
 * The model a resume of this run would actually use. A tool-use session that
 * was switched to another model records that only inside its checkpoint, so
 * `history show` parses it — one parse for the one run asked about — while a
 * listing reports the model the run started under.
 *
 * Never throws: a checkpoint that cannot be loaded has no model to report, and
 * refusing such a run is the open path's job, not this row's.
 */
export async function readCliResumedModel(
  id: ExecutionId,
  config: AgentConfig,
): Promise<string | undefined> {
  try {
    // FK-first: the stream id stamped on execution metadata at registration is
    // the reproduction contract — never re-derived from agent/model.
    const streamId = (await getExecutionStore(id).readMeta())?.streamId;
    if (!streamId) return undefined;
    const resume = await retrieveSessionResumeData(streamId, id, config);
    return resume?.type === 'toolUse' ? resume.agentConfig.model : undefined;
  } catch (error) {
    logger.debug(
      `No resumed model for history entry ${id}: ${toErrorMessage(error)}`,
    );
    return undefined;
  }
}
