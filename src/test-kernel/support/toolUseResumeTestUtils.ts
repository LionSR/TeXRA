import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { PreparedShared } from '@agent/implementations/flows/tooluse/nodes/types';
import type { ToolUseResumeData } from '@agent/runtime/SessionResumeRetrieval';
import { AgentRunStateSnapshotSchema, type RunId } from '@shared/schemas';

export function createToolUseResumeShared(
  overrides: Partial<PreparedShared> = {},
): PreparedShared {
  return {
    messages: [],
    shouldSkipCycle: false,
    stateSlices: {
      runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
      workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
      userChannels: {},
    },
    ...overrides,
  };
}

/**
 * The identity a host resumes a tool-use run under: the config, the run id
 * and the conversation format its rows are in. The run's state is not part
 * of it — the loop folds that from the ledger.
 */
export function createToolUseResumeData(
  overrides: Partial<ToolUseResumeData> = {},
): ToolUseResumeData {
  return {
    type: 'toolUse',
    runId: 'test-run' as RunId,
    agentConfig: AgentConfigSchema.parse({
      agent: 'test-agent',
      model: 'test-model',
      agentCategory: 'toolUse',
    }),
    modelHandlerCompatibilityKey: null,
    ...overrides,
  };
}
