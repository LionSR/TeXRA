import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { PreparedShared } from '@agent/implementations/flows/tooluse/nodes/types';
import type { ToolUseResumeData } from '@agent/runtime/SessionResumeRetrieval';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

export function createToolUseResumeShared(
  overrides: Partial<PreparedShared> = {},
): PreparedShared {
  return {
    messages: [],
    shouldSkipCycle: false,
    stateSlices: {
      runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
      workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
      userChannels: { input: {}, transient: {} },
    },
    ...overrides,
  };
}

export function createToolUseResumeData(
  overrides: Partial<Omit<ToolUseResumeData, 'shared'>> & {
    readonly shared?: Partial<PreparedShared>;
  } = {},
): ToolUseResumeData {
  const shared = createToolUseResumeShared(overrides.shared);
  return {
    type: 'toolUse',
    executionId: 'test-execution' as ExecutionId,
    streamId: 'test-stream' as StreamTabId,
    agentConfig: AgentConfigSchema.parse({
      agent: 'test-agent',
      model: 'test-model',
      agentCategory: 'toolUse',
    }),
    sourceShared: structuredClone(shared),
    ...overrides,
    shared,
  };
}
