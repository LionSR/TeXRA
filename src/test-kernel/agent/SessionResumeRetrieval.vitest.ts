import { beforeEach, describe, expect, it } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';
import { getExecutionStore } from '@agent/storage';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentRunStateSnapshotSchema } from '@agent/core/execution/AgentState';
import { AgentWorkspaceState } from '@agent/core/execution/AgentWorkspaceState';
import { flowKey } from '@agent/node/persistedFlow';
import { retrieveSessionResumeData } from '@agent/runtime/SessionResumeRetrieval';
import { agentConfigToTaskState } from '@agent/utils/agentConfigToTaskState';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

const CONFIG: AgentConfig = {
  inputFiles: [],
  contextFiles: [],
  mediaFiles: [],
  outputFiles: [],
  editedFile: null,
  agent: 'chat',
  model: 'gpt54',
  instruction: 'Continue.',
  agentCategory: AgentCategory.ToolUse,
  editedFiles: [],
  toolConfig: DEFAULT_TOOL_CONFIG,
  memories: [],
  workingDirectory: '/workspace',
  cliOutputFile: null,
  cliMultiAgentPresetId: null,
};

beforeEach(async () => {
  const { initPlatform } = await import('@platform/platform');
  initPlatform(createFakePlatform({ workspacePath: '/workspace' }));
});

describe('retrieveSessionResumeData', () => {
  it('uses the persisted current model while preserving the original stream id', async () => {
    const executionId = 'abc123' as ExecutionId;
    const streamId = 'chat@gpt54#abc123' as StreamTabId;
    await getExecutionStore(executionId).write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: {
        messages: [],
        shouldSkipCycle: false,
        stateSlices: {
          runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
          workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
          userChannels: {
            input: Object.freeze({ MODEL: 'gpt54' }),
            transient: { MODEL: 'gpt55' },
          },
        },
      },
      createdAt: new Date().toISOString(),
      nodes: [],
    });

    const resume = await retrieveSessionResumeData(
      streamId,
      executionId,
      agentConfigToTaskState(CONFIG),
    );

    expect(resume?.type).toBe('toolUse');
    if (resume?.type !== 'toolUse') return;
    expect(resume.snapshot.streamId).toBe(streamId);
    expect(resume.snapshot.agentConfig.model).toBe('gpt55');
  });
});
