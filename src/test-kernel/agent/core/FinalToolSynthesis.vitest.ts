import { describe, expect, it, vi } from 'vitest';

import type { ToolUseRoundServices } from '@agent/core/flows/CycleServices';
import {
  createToolUseRoundFlow,
  type ToolUseRoundShared,
} from '@agent/core/flows/ToolUseRoundFlow';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { CreateResponseOptions } from '@agent/types/ModelHandlerContracts';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import { createRunTrace, StreamLogStore } from '@transcript';
import { withTestRunContext } from '../progressTestUtils';

function buildRound(supportsForcedToolChoice: boolean) {
  const requests: CreateResponseOptions[] = [];
  const createResponse = vi.fn(async (options: CreateResponseOptions) => {
    requests.push(options);
    return { response: { turn: requests.length } };
  });
  const modelHandler = {
    addMediaToUserMessage: vi.fn(async () => []),
    capabilities: { supportsVision: true },
    config: { provider: 'openai', fullName: 'test-model' },
    createAssistantMessageFromResponse: vi.fn(
      (_response: unknown, text: string) =>
        ({ role: 'assistant', content: text }) as ProviderMessage,
    ),
    createResponse,
    createUserFollowUpMessages: vi.fn(
      async (messages: ProviderMessage[], text: string) => [
        ...messages,
        { role: 'user', content: text } as ProviderMessage,
      ],
    ),
    extractAssistantContent: () => [],
    extractResponse: (response: { turn: number }) => ({
      text: response.turn === 1 ? 'Draft answer' : '',
      usage: null,
      stopReason: 'stop',
    }),
    extractServerToolData: () => ({
      contentBlocks: [],
      webFetchResults: [],
      webSearchResults: [],
    }),
    extractToolUse: () => [],
    getWireRouteKey: () => 'openai:test-route',
    getStreamingConfig: () => false,
    isEndTurnStop: () => true,
    processThinkingBlock: () => null,
    setOutputStreaming: vi.fn(),
    supportsForcedToolChoice,
  };
  const services = {
    checkInterruption: () => false,
    client: {},
    config: { agent: 'test-agent', model: 'test-model' },
    fileService: {
      createLocation: (filePath: string) => ({ absolutePath: filePath }),
    },
    finalTool: { name: 'submit_output' },
    logger: createRunTrace(
      'FinalToolSynthesis',
      StreamLogStore.ephemeral('test'),
    ).trace,
    modelHandler,
    onRoundFinalized: vi.fn(),
    run: AgentRunStateSnapshotSchema.parse({}),
    session: { hasQueuedFollowUp: () => false },
    setAbortController: vi.fn(),
    setting: {
      temperature: 0,
      tools: [{ name: 'submit_output', description: 'Submit output' }],
    },
    workspace: AgentWorkspaceState.create(),
  } as unknown as ToolUseRoundServices;
  const shared: ToolUseRoundShared = {
    messages: [{ role: 'user', content: 'Research this' }],
    shouldStop: false,
    endTurn: false,
    roundIndex: 0,
    roundResponseTimeMs: 0,
  };

  return { requests, services, shared };
}

describe('final-tool synthesis turn', () => {
  it('keeps exploration unforced, then forces exactly one final turn', async () => {
    const { requests, services, shared } = buildRound(true);

    await withTestRunContext(noopAgentRuntimeHost, 'final-tool-synthesis', () =>
      createToolUseRoundFlow().setServices(services).run(shared),
    );

    expect(requests.map((request) => request.finalTool)).toEqual([
      undefined,
      { name: 'submit_output' },
    ]);
    expect(shared.finalTool).toBeUndefined();
    expect(shared.finalToolAttempted).toBe(true);
    expect(shared.messages).toEqual([
      { role: 'user', content: 'Research this' },
      { role: 'assistant', content: 'Draft answer' },
      { role: 'user', content: 'Submit the final structured output now.' },
    ]);
  });

  it('uses the unforced floor when the provider cannot force tools', async () => {
    const { requests, services, shared } = buildRound(false);

    await withTestRunContext(noopAgentRuntimeHost, 'final-tool-floor', () =>
      createToolUseRoundFlow().setServices(services).run(shared),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.finalTool).toBeUndefined();
  });
});
