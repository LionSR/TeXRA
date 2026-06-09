// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - agent core
import { createRunTrace } from '@transcript';
import { AgentRunStateSnapshotSchema } from '@agent/core/execution/AgentState';
import { AgentWorkspaceState } from '@agent/core/execution/AgentWorkspaceState';
import type { ToolUseCycleServices } from '@agent/core/flows/CycleServices';
import {
  createToolUseCycleFlow,
  type ToolUseCycleShared,
} from '@agent/core/flows/ToolUseCycleFlow';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { StreamStatusRegistry } from '@agent/runtime/StreamStatusService';

describe('ToolUseCycleFlow queued follow-ups', () => {
  it('attaches media from follow-ups queued at cycle start', async () => {
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
      logger: createRunTrace('ToolUseCycleFollowUpMedia').trace,
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
    } as unknown as ToolUseCycleServices;

    const shared: ToolUseCycleShared = {
      messages: [],
      shouldStop: false,
      endTurn: false,
      response: undefined,
      responseTimeMs: undefined,
      stopReason: undefined,
      lastError: undefined,
      toolCalls: undefined,
      text: undefined,
      cycleIndex: 0,
      cycleResponseTimeMs: 0,
      cycleNormalizedUsage: undefined,
    };

    await createToolUseCycleFlow().setServices(services).run(shared);

    expect(createUserFollowUpMessages).toHaveBeenCalledWith(
      [],
      'inspect the pasted figure',
    );
    expect(addMediaToUserMessage).toHaveBeenCalledWith(shared.messages, [
      { absolutePath: '/tmp/figure.png' },
    ]);
  });
});
