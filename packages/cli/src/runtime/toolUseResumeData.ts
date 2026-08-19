import { deriveOfferableResumability, getExecutionStore } from '@agent/storage';
import {
  retrieveSessionResumeData,
  type AgentConfig,
  type ToolUseResumeData,
} from '@agent/runtime';
import { createLog } from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const logger = createLog('CliToolUseResumeData');
type CliSessionResumeData = NonNullable<
  Awaited<ReturnType<typeof retrieveSessionResumeData>>
>;

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

export async function readCliToolUseResumeData(
  id: ExecutionId,
  config: AgentConfig,
): Promise<ToolUseResumeData | null> {
  if (config.agentCategory !== AgentCategory.ToolUse) return null;

  const resume = await readCliSessionResumeData(id, config);
  if (resume?.type !== 'toolUse') return null;
  return resume;
}

/**
 * Category-aware, listing-safe resume validation. History listings enrich
 * many entries at once, so one unreadable flow record must not abort the whole
 * listing: degrade to `null` on retrieval failure. The returned value is the
 * same category-specific state accepted by the active resume path.
 *
 * Listings advertise resumability to a person, so they ask
 * `deriveOfferableResumability` rather than the durable-state-only
 * `deriveResumability`: a run that is executing right now also has a flow
 * record and no outcome, and `texra resume` would refuse it anyway.
 */
export async function readCliResumeDataForListing(
  id: ExecutionId,
  config: AgentConfig,
): Promise<CliSessionResumeData | null> {
  try {
    if (!(await deriveOfferableResumability(id)).resumable) return null;
    return await readCliSessionResumeData(id, config);
  } catch (error) {
    logger.debug(
      `Ignoring unreadable resume data for history entry ${id}: ${toErrorMessage(error)}`,
    );
    return null;
  }
}
