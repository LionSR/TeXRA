import {
  classifyRun,
  hasTerminalPersistedCompileRejection,
  retrieveSessionResumeData,
  type AgentConfig,
} from '@agent/runtime';
import { readExecutionMeta } from '@agent/storage';
import { createLog } from '@logger/logUtils';
import { AgentCategory, type ExecutionId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const logger = createLog('CliToolUseResumeData');
type CliSessionResumeData = NonNullable<
  Awaited<ReturnType<typeof retrieveSessionResumeData>>
>;

async function readCliSessionResumeData(
  id: ExecutionId,
  config: AgentConfig,
): Promise<CliSessionResumeData | null> {
  const streamId = (await readExecutionMeta(id))?.streamId;
  if (!streamId) return null;
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
export async function readCliResumeDataForListing(
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
