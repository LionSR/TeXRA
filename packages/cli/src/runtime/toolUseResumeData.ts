import {
  classifyRun,
  hasTerminalPersistedCompileRejection,
  retrieveSessionResumeData,
  type AgentConfig,
} from '@agent/runtime';
import { readExecutionStreamId } from '@agent/storage';
import { createLog } from '@logger/logUtils';
import {
  AgentCategory,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const logger = createLog('CliToolUseResumeData');
type CliSessionResumeData = NonNullable<
  Awaited<ReturnType<typeof retrieveSessionResumeData>>
>;

async function readCliSessionResumeData(
  id: ExecutionId,
  streamId: StreamTabId,
  config: AgentConfig,
): Promise<CliSessionResumeData | null> {
  return (await retrieveSessionResumeData(streamId, id, config)) ?? null;
}

/**
 * Category-aware, listing-safe resume validation. History listings enrich
 * many entries at once, so one unreadable flow record must not abort the whole
 * listing: degrade to `null` on retrieval failure. The returned value is the
 * same category-specific state accepted by the active resume path.
 *
 * Listings advertise resumability to a person, so they ask `classifyRun`
 * rather than the durable-state-only `deriveResumability`: a run that is
 * executing right now also has a flow record and no outcome, and
 * `texra resume` would refuse it anyway.
 */
export async function readCliResumeDataForKnownStream(
  id: ExecutionId,
  streamId: StreamTabId | undefined,
  config: AgentConfig,
): Promise<CliSessionResumeData | null> {
  try {
    if (!streamId || (await classifyRun(id)).kind !== 'resumable') return null;
    if (
      config.agentCategory === AgentCategory.Workflow &&
      (await hasTerminalPersistedCompileRejection(id))
    ) {
      return null;
    }
    return await readCliSessionResumeData(id, streamId, config);
  } catch (error) {
    logger.debug(
      `Ignoring unreadable resume data for history entry ${id}: ${toErrorMessage(error)}`,
    );
    return null;
  }
}

export async function readCliResumeDataForListing(
  id: ExecutionId,
  config: AgentConfig,
): Promise<CliSessionResumeData | null> {
  try {
    return await readCliResumeDataForKnownStream(
      id,
      await readExecutionStreamId(id),
      config,
    );
  } catch (error) {
    logger.debug(
      `Ignoring unreadable resume data for history entry ${id}: ${toErrorMessage(error)}`,
    );
    return null;
  }
}
