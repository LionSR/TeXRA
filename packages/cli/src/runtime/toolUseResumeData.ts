import {
  isRuntimeToolUseTaskState,
  type RuntimeAgentConfig,
} from '@agent/runtime/executionRequests';
import type { RuntimeToolUseSessionSnapshot } from '@agent/runtime/resumeCommands';
import { retrieveSessionResumeData } from '@agent/runtime/SessionResumeRetrieval';
import { getStreamTabId } from '@agent/runtime/streamTab';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import { toErrorMessage } from '@common/errors';
import { createChannelTrace } from '@logger';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

const logger = createChannelTrace('CliToolUseResumeData');

export interface CliToolUseResumeData {
  readonly snapshot: RuntimeToolUseSessionSnapshot;
  readonly streamId: StreamTabId;
  readonly config: RuntimeAgentConfig;
}

export async function readCliToolUseResumeData(
  id: ExecutionId,
  config: RuntimeAgentConfig,
): Promise<CliToolUseResumeData | null> {
  const taskState = agentConfigToTaskState(config);
  if (!isRuntimeToolUseTaskState(taskState)) return null;

  const streamId = getStreamTabId(config.agent, config.model, {
    executionId: id,
  });
  const resume = await retrieveSessionResumeData(streamId, id, taskState);
  if (resume?.type !== 'toolUse') return null;
  return {
    snapshot: resume.snapshot,
    streamId,
    config: resume.snapshot.agentConfig,
  };
}

/**
 * Listing-safe variant. History listings enrich many entries at once, so a
 * single unreadable/corrupt flow record must not abort the whole listing:
 * degrade to `null` on retrieval failure. Use {@link readCliToolUseResumeData}
 * (which propagates) on the active-resume path, where a failure must surface.
 */
export async function readCliToolUseResumeDataForListing(
  id: ExecutionId,
  config: RuntimeAgentConfig,
): Promise<CliToolUseResumeData | null> {
  try {
    return await readCliToolUseResumeData(id, config);
  } catch (error) {
    logger.debug(
      `Ignoring unreadable resume data for history entry ${id}: ${toErrorMessage(error)}`,
    );
    return null;
  }
}
