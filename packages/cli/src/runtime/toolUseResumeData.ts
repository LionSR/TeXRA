import { createChannelTrace } from '@agent/trace';
import { getExecutionStore } from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  retrieveSessionResumeData,
  type ToolUseResumeData,
} from '@agent/runtime/SessionResumeRetrieval';
import type { ExecutionId } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const logger = createChannelTrace('CliToolUseResumeData');

export async function readCliToolUseResumeData(
  id: ExecutionId,
  config: AgentConfig,
): Promise<ToolUseResumeData | null> {
  if (config.agentCategory !== AgentCategory.ToolUse) return null;

  // FK-first: the stream id stamped on execution metadata at registration is
  // the reproduction contract — never re-derived from agent/model. A row
  // without a stamped stream id has no persisted stream and is not resumable.
  const streamId = (await getExecutionStore(id).readMeta())?.streamId;
  if (!streamId) return null;
  const resume = await retrieveSessionResumeData(streamId, id, config);
  if (resume?.type !== 'toolUse') return null;
  return resume;
}

/**
 * Listing-safe variant. History listings enrich many entries at once, so a
 * single unreadable/corrupt flow record must not abort the whole listing:
 * degrade to `null` on retrieval failure. Use {@link readCliToolUseResumeData}
 * (which propagates) on the active-resume path, where a failure must surface.
 */
export async function readCliToolUseResumeDataForListing(
  id: ExecutionId,
  config: AgentConfig,
): Promise<ToolUseResumeData | null> {
  try {
    return await readCliToolUseResumeData(id, config);
  } catch (error) {
    logger.debug(
      `Ignoring unreadable resume data for history entry ${id}: ${toErrorMessage(error)}`,
    );
    return null;
  }
}
