// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - agent core
import { createRunTrace } from '@transcript';
import { AgentRunStateSnapshotSchema } from '@agent/core/execution/AgentState';
import { AgentWorkspaceState } from '@agent/core/execution/AgentWorkspaceState';
import type { ToolUseRoundServices } from '@agent/core/flows/CycleServices';
import {
  createToolUseRoundFlow,
  type ToolUseRoundShared,
} from '@agent/core/flows/ToolUseRoundFlow';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { StreamStatusRegistry } from '@agent/runtime/StreamStatusService';

describe('ToolUseRoundFlow queued follow-ups', () => {
  it('attaches media from follow-ups queued at round start', async () => {
    const createUserFollowUpMessages = vi.fn(
      async (messages: ProviderMessage[], userMessage: string) =>
        [
          ...messages,
          { role: 'user', content: userMessage },
        ] as ProviderMessage[],
    );
    const addMediaToUserMessage = vi.fn(async () => {});

    const services = {
      checkInterruption: () => false,
      client: {},
      config: { agent: 'test-agent', model: 'test-model' },
      executionId: 'test-exec',
      fileService: {
        createLocation: (filePath: string) => ({ absolutePath: filePath }),
      },
      logger: createRunTrace('ToolUseRoundFollowUpMedia').trace,
      modelHandler: {
        addMediaToUserMessage,
        capabilities: { supportsVision: true },
        createResponse: vi.fn(async () => ({ response: null })),
        createUserFollowUpMessages,
        setOutputStreaming: vi.fn(),
      },
      prompt: { systemPrompt: '', userPrefix: '', userRequest: '' },
      run: AgentRunStateSnapshotSchema.parse({}),
      runtimeHost: noopAgentRuntimeHost,
      session: {
        hasQueuedFollowUp: () => true,
        waitForFollowUp: async () => ({
          items: [
            {
              text: 'inspect the pasted figure',
              mediaFiles: ['/tmp/figure.png'],
              origin: 'user' as const,
            },
          ],
          synthetic: false,
        }),
      },
      setAbortController: () => {},
      setting: { temperature: 0, tools: [] },
      streamId: 'test-stream',
      streamStatus: new StreamStatusRegistry(),
      toolRegistry: new MapToolRegistry({}),
      userVarChannels: { input: {}, transient: {} },
      workspace: AgentWorkspaceState.create(),
    } as unknown as ToolUseRoundServices;

    const shared: ToolUseRoundShared = {
      messages: [],
      shouldStop: false,
      endTurn: false,
      response: undefined,
      responseTimeMs: undefined,
      stopReason: undefined,
      lastError: undefined,
      toolCalls: undefined,
      text: undefined,
      roundIndex: 0,
      roundResponseTimeMs: 0,
      roundNormalizedUsage: undefined,
    };

    await createToolUseRoundFlow().setServices(services).run(shared);

    expect(createUserFollowUpMessages).toHaveBeenCalledWith(
      [],
      'inspect the pasted figure',
    );
    expect(addMediaToUserMessage).toHaveBeenCalledWith(shared.messages, [
      { absolutePath: '/tmp/figure.png' },
    ]);
  });
});
