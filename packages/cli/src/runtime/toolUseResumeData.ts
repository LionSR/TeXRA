import { createChannelTrace } from '@agent/trace';
import { isToolUseTaskState } from '@agent/core/state/TaskState';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  retrieveSessionResumeData,
  type ToolUseResumeData,
} from '@agent/runtime/SessionResumeRetrieval';
import { getStreamTabId } from '@agent/runtime/streamTab';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import type { ExecutionId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const logger = createChannelTrace('CliToolUseResumeData');

export async function readCliToolUseResumeData(
  id: ExecutionId,
  config: AgentConfig,
): Promise<ToolUseResumeData | null> {
  const taskState = agentConfigToTaskState(config);
  if (!isToolUseTaskState(taskState)) return null;

  const streamId = getStreamTabId(config.agent, config.model, {
    executionId: id,
  });
  const resume = await retrieveSessionResumeData(streamId, id, taskState);
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
