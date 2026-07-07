// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - agent core
import { createRunTrace } from '@transcript';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { ToolUseRoundServices } from '@agent/core/flows/CycleServices';
import {
  createToolUseRoundFlow,
  type ToolUseRoundShared,
} from '@agent/core/flows/ToolUseRoundFlow';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import { withTestRunContext } from '../progressTestUtils';

describe('ToolUseRoundFlow systemPrompt gating', () => {
  function createShared(): ToolUseRoundShared {
    return {
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
      systemPrompt: 'You are a helpful assistant.',
    };
  }

  function createServices(requiresPerCallSystemPrompt: boolean): {
    createResponse: ReturnType<typeof vi.fn>;
    services: ToolUseRoundServices;
  } {
    const createResponse = vi.fn(async () => ({
      response: { id: 'r1', text: 'done' },
    }));

    const services = {
      checkInterruption: () => false,
      client: {},
      config: { agent: 'test-agent', model: 'test-model' },
      fileService: {
        createLocation: (filePath: string) => ({ absolutePath: filePath }),
      },
      logger: createRunTrace('ToolUseRoundSystemPrompt').trace,
      modelHandler: {
        addMediaToUserMessage: vi.fn(async () => {}),
        capabilities: { supportsVision: true },
        createAssistantMessageFromResponse: vi.fn(
          (_response: unknown, text: string) =>
            ({ type: 'message', role: 'assistant', content: text }) as never,
        ),
        createResponse,
        extractAssistantContent: () => [],
        extractResponse: (response: { text?: string }) => ({
          text: response.text ?? '',
          usage: null,
          stopReason: 'stop',
        }),
        extractServerToolData: () => ({
          contentBlocks: [],
          webFetchResults: [],
          webSearchResults: [],
        }),
        extractToolUse: () => [],
        getStreamingConfig: () => false,
        isEndTurnStop: (stopReason: string) => stopReason === 'stop',
        processThinkingBlock: () => null,
        requiresPerCallSystemPrompt,
        setOutputStreaming: vi.fn(),
      },
      prompt: { systemPrompt: '', userPrefix: '', userRequest: '' },
      run: AgentRunStateSnapshotSchema.parse({}),
      session: {
        hasQueuedFollowUp: () => false,
      },
      setAbortController: () => {},
      setting: { temperature: 0, tools: [] },
      streamStatus: new StreamStatusMachine(),
      toolRegistry: new MapToolRegistry({}),
      userVarChannels: { input: {}, transient: {} },
      workspace: AgentWorkspaceState.create(),
    } as unknown as ToolUseRoundServices;

    return { createResponse, services };
  }

  function runRound(
    services: ToolUseRoundServices,
    shared: ToolUseRoundShared,
  ): Promise<string | undefined> {
    return withTestRunContext(noopAgentRuntimeHost, 'test-stream', () =>
      createToolUseRoundFlow().setServices(services).run(shared),
    );
  }

  it('passes systemPrompt to createResponse when the handler requires it per-call', async () => {
    const { createResponse, services } = createServices(true);
    const shared = createShared();

    await runRound(services, shared);

    expect(createResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'You are a helpful assistant.',
      }),
    );
  });

  it('omits systemPrompt from createResponse when the handler embeds it in messages', async () => {
    const { createResponse, services } = createServices(false);
    const shared = createShared();

    await runRound(services, shared);

    expect(createResponse).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: undefined }),
    );
  });
});
