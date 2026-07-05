import { describe, expect, it } from 'vitest';

import { setupPlatform } from '@test/support/setupPlatform';
import { getExecutionStore } from '@agent/storage';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
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
const GOOGLE_CONFIG: AgentConfig = { ...CONFIG, model: 'gemini35f' };
const GOOGLE_WORKFLOW_CONFIG: AgentConfig = {
  ...GOOGLE_CONFIG,
  agentCategory: AgentCategory.Workflow,
};

describe('retrieveSessionResumeData', () => {
  setupPlatform({ workspacePath: '/workspace' });

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

  it('infers the legacy Google GenAI handler for old Google Content transcripts', async () => {
    const executionId = 'abc124' as ExecutionId;
    const streamId = 'chat@gemini35f#abc124' as StreamTabId;
    await getExecutionStore(executionId).write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: {
        messages: [
          {
            role: 'user',
            parts: [{ text: 'Continue the old chat transcript.' }],
          },
        ],
        shouldSkipCycle: false,
        stateSlices: {
          runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
          workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
          userChannels: {
            input: Object.freeze({ MODEL: 'gemini35f' }),
            transient: {},
          },
        },
      },
      createdAt: new Date().toISOString(),
      nodes: [],
    });

    const resume = await retrieveSessionResumeData(
      streamId,
      executionId,
      agentConfigToTaskState(GOOGLE_CONFIG),
    );

    expect(resume?.type).toBe('toolUse');
    if (resume?.type !== 'toolUse') return;
    expect(resume.snapshot.modelHandlerCompatibilityKey).toBe(
      'ModelHandlerGoogleGenAI',
    );
  });

  it('normalizes legacy nested conversation shared state for tool-use resume', async () => {
    const executionId = 'abc128' as ExecutionId;
    const streamId = 'chat@gpt54#abc128' as StreamTabId;
    await getExecutionStore(executionId).write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: {
        state: {
          conversation: [
            {
              role: 'user',
              content: 'Continue the legacy conversation.',
            },
          ],
          shouldSkipCycle: false,
          stateSlices: {
            runStateSnapshot: AgentRunStateSnapshotSchema.parse({}),
            workspaceSnapshot: AgentWorkspaceState.create().toSnapshot(),
            userChannels: {
              input: Object.freeze({ MODEL: 'gpt54' }),
              transient: {},
            },
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
    expect(resume.snapshot.messages).toEqual([
      {
        role: 'user',
        content: 'Continue the legacy conversation.',
      },
    ]);
  });

  it('infers the legacy Google GenAI handler for old workflow transcripts', async () => {
    const executionId = 'abc125' as ExecutionId;
    const streamId = 'workflow@gemini35f#abc125' as StreamTabId;
    await getExecutionStore(executionId).write(flowKey(executionId), {
      flowName: 'texra',
      params: {},
      shared: {
        currentRound: 1,
        totalRounds: 2,
        conversation: [
          {
            role: 'user',
            parts: [{ text: 'Continue the old workflow transcript.' }],
          },
        ],
      },
      createdAt: new Date().toISOString(),
      nodes: [],
    });

    const resume = await retrieveSessionResumeData(
      streamId,
      executionId,
      agentConfigToTaskState(GOOGLE_WORKFLOW_CONFIG),
    );

    expect(resume?.type).toBe('workflow');
    if (resume?.type !== 'workflow') return;
    expect(resume.modelHandlerCompatibilityKey).toBe('ModelHandlerGoogleGenAI');
  });
});
