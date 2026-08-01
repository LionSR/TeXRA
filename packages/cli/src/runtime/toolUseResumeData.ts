import { createChannelTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  retrieveSessionResumeData,
  type ToolUseResumeData,
} from '@agent/runtime/SessionResumeRetrieval';
import { getStreamTabId } from '@agent/runtime/streamTab';
import type { ExecutionId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const logger = createChannelTrace('CliToolUseResumeData');

export async function readCliToolUseResumeData(
  id: ExecutionId,
  config: AgentConfig,
): Promise<ToolUseResumeData | null> {
  if (config.agentCategory !== AgentCategory.ToolUse) return null;

  const streamId = getStreamTabId(config.agent, config.model, {
    executionId: id,
  });
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
