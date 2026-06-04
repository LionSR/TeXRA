import { isToolUseTaskState } from '@agent/core/execution/TaskState';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse';
import { retrieveSessionResumeData } from '@agent/runtime/SessionResumeRetrieval';
import { getStreamTabId } from '@agent/runtime/streamTab';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

export interface CliToolUseResumeData {
  readonly snapshot: ToolUseSessionSnapshot;
  readonly streamId: StreamTabId;
  readonly config: AgentConfig;
}

export async function readCliToolUseResumeData(
  id: ExecutionId,
  config: AgentConfig,
): Promise<CliToolUseResumeData | null> {
  const taskState = agentConfigToTaskState(config);
  if (!isToolUseTaskState(taskState)) return null;

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
