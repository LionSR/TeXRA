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
 * per row. Loadability is not inspected for its own sake either — a checkpoint
 * that exists but cannot be parsed is refused at open time as
 * `unusable_checkpoint`, which is what that cohort actually is — so where the
 * exception below does read a record, a parse failure defers to open rather
 * than deciding anything here.
 *
 * The one exception buys back a refusal the user would otherwise be walked
 * into: a workflow that stopped at its round cap on an unresolved compile
 * rejection has a checkpoint that only replays the same rejection. Reading it
 * is a full Zod parse, so it runs only where such a rejection can still be
 * recorded. `OutputNode` writes the marker during the final round, before the
 * run lifecycle records `meta.outcome`, so the terminal outcomes that prove
 * `resolveOutcome` already ran — CANCELLED and COMPLETED, neither of which
 * `deriveRunOutcome` can produce over a terminal rejection — skip the parse,
 * while FAILED and a missing outcome are read.
 *
 * The cost of covering the missing outcome is one parse per outcome-less
 * workflow row that already passed both free gates: a workflow that crashed
 * between the marker write and its finalization. Legacy rows predating the
 * outcome field are outcome-less too but carry no stamped stream id, so they
 * are refused by the gate above without a read.
 */
export async function isCliRunResumable(
  facts: CliRunResumabilityFacts,
): Promise<boolean> {
  if (!facts.checkpointPresent || !facts.streamId) return false;
  if (facts.agentCategory !== AgentCategory.Workflow) return true;
  if (
    facts.outcome === RUN_OUTCOME.CANCELLED ||
    facts.outcome === RUN_OUTCOME.COMPLETED
  ) {
    return true;
  }
  try {
    return !(await hasTerminalPersistedCompileRejection(facts.id));
  } catch (error) {
    // A record that cannot be read is not evidence of a terminal rejection,
    // and hiding the row would be the one silent refusal on this surface:
    // every other unreadable checkpoint is advertised and refused at open as
    // `unusable_checkpoint`. Advertise, and let the open path word it.
    logger.warn(
      `Advertising workflow ${facts.id} as resumable without reading its persisted state: ${toErrorMessage(error)}`,
      { data: error },
    );
    return true;
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
