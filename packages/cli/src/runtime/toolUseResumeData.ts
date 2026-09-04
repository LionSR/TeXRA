import {
  classifyRun,
  hasTerminalPersistedCompileRejection,
  retrieveSessionResumeData,
  type AgentConfig,
} from '@agent/runtime';
import {
  getExecutionStore,
  type AgentExecutionListingEntry,
} from '@agent/storage';
import { createLog } from '@logger/logUtils';
import { AgentCategory, type ExecutionId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const logger = createLog('CliToolUseResumeData');
type CliSessionResumeData = NonNullable<
  Awaited<ReturnType<typeof retrieveSessionResumeData>>
>;

/**
 * Whether a history listing may advertise a row as continuable, decided from
 * facts the listing already carries: a checkpoint file exists (one `stat` per
 * row in `listExecutions`) and the row has the stream id stamped on its
 * metadata at registration — the reproduction contract, without which there is
 * no persisted stream to continue.
 *
 * Ownership is deliberately not inspected here. A run another process is
 * executing right now has a checkpoint and no outcome, so it lists as
 * resumable and is refused when the user opens it; that costs one lease read
 * on the one run they picked instead of one per row.
 *
 * The one read left is the workflow compile-rejection filter, and only for a
 * workflow row the two free facts have already accepted: such a run's
 * checkpoint exists but records a rejection at its round cap, so resume
 * refuses it and the listing must not offer it. An unreadable or malformed
 * record is not advertised either — that is unknown state, not a continuable
 * run.
 */
export async function isCliListingResumable(
  entry: AgentExecutionListingEntry,
): Promise<boolean> {
  if (!entry.checkpointPresent || !entry.streamId) return false;
  if (entry.record.agentCategory !== AgentCategory.Workflow) return true;
  try {
    return !(await hasTerminalPersistedCompileRejection(entry.id));
  } catch (error) {
    logger.warn(
      `Not advertising workflow ${entry.id} as resumable: its persisted state is unreadable: ${toErrorMessage(error)}`,
      { data: error },
    );
    return false;
  }
}

async function readCliSessionResumeData(
  id: ExecutionId,
  config: AgentConfig,
): Promise<CliSessionResumeData | null> {
  // FK-first: the stream id stamped on execution metadata at registration is
  // the reproduction contract — never re-derived from agent/model. A row
  // without a stamped stream id has no persisted stream and is not resumable.
  const streamId = (await getExecutionStore(id).readMeta())?.streamId;
  if (!streamId) return null;
  return (await retrieveSessionResumeData(streamId, id, config)) ?? null;
}

/**
 * Category-aware resume validation for the one run `history show` was asked
 * about, where a full checkpoint parse is proportionate: it answers both
 * "is there a category-valid flow record" and "what model would a resume run
 * under". Never throws — an unreadable flow record degrades to `null` rather
 * than failing the whole detail read.
 *
 * It asks `classifyRun` rather than the durable-state-only
 * `deriveResumability` because it reports to a person: a run that is
 * executing right now also has a flow record and no outcome, and
 * `texra resume` would refuse it anyway.
 */
export async function readCliResumeDataForDetails(
  id: ExecutionId,
  config: AgentConfig,
): Promise<CliSessionResumeData | null> {
  try {
    if ((await classifyRun(id)).kind !== 'resumable') return null;
    if (
      config.agentCategory === AgentCategory.Workflow &&
      (await hasTerminalPersistedCompileRejection(id))
    ) {
      return null;
    }
    return await readCliSessionResumeData(id, config);
  } catch (error) {
    logger.debug(
      `Ignoring unreadable resume data for history entry ${id}: ${toErrorMessage(error)}`,
    );
    return null;
  }
}
