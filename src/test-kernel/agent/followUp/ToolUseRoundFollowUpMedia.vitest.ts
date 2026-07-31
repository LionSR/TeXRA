// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import type { ToolUseRoundServices } from '@agent/core/flows/CycleServices';
import {
  createToolUseRoundFlow,
  type ToolUseRoundShared,
} from '@agent/core/flows/ToolUseRoundFlow';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import type { ProviderMessage } from '@agent/types/ProviderMessage';

// Local file imports
import { withTestRunContext } from '../progressTestUtils';
import { baseRoundServices, roundModelHandler } from '../toolUseRoundTestUtils';

describe('ToolUseRoundFlow queued follow-ups', () => {
  it('attaches media from follow-ups queued at round start', async () => {
    const createUserFollowUpMessages = vi.fn(
      async (messages: ProviderMessage[], userMessage: string) =>
        [
          ...messages,
          { role: 'user', content: userMessage },
        ] as ProviderMessage[],
    );
    const addMediaToUserMessage = vi.fn(async () => []);

    const services = {
      ...baseRoundServices('ToolUseRoundFollowUpMedia'),
      modelHandler: {
        addMediaToUserMessage,
        capabilities: { supportsVision: true },
        config: { provider: 'openai', fullName: 'test-model' },
        createResponse: vi.fn(async () => ({ response: null })),
        createUserFollowUpMessages,
        getWireRouteKey: () => 'openai:test-route',
        getModelRetryRouteKey: () => 'openai:test-route:model',
        setOutputStreaming: vi.fn(),
      },
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
      setting: { temperature: 0, tools: [] },
      toolRegistry: new MapToolRegistry({}),
    } as unknown as ToolUseRoundServices;

    const shared = createShared([]);

    await runRound(services, shared);

    expect(createUserFollowUpMessages).toHaveBeenCalledWith(
      [],
      'inspect the pasted figure',
    );
    expect(addMediaToUserMessage).toHaveBeenCalledWith(shared.messages, [
      { absolutePath: '/tmp/figure.png' },
    ]);
  });

  function toolResultMessage(callId: string): ProviderMessage {
    return {
      type: 'function_call_output',
      call_id: callId,
      output: 'tool completed',
    } as ProviderMessage;
  }

  function interactionsFunctionResultMessage(callId: string): ProviderMessage {
    return {
      type: 'function_result',
      call_id: callId,
      result: [{ type: 'text', text: 'tool completed' }],
    } as ProviderMessage;
  }

  function vscodeLmToolResultMessage(callId: string): ProviderMessage {
    return {
      role: 'user',
      content: [{ kind: 'toolResult', callId, text: 'tool completed' }],
    } as ProviderMessage;
  }

  function createShared(
    messages: ProviderMessage[],
    systemPrompt?: string,
  ): ToolUseRoundShared {
    return {
      messages,
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
      systemPrompt,
    };
  }

  function runRound(
    services: ToolUseRoundServices,
    shared: ToolUseRoundShared,
  ): Promise<string | undefined> {
    const { session } = services.runScope;
    return withTestRunContext(
      session.interactions,
      'test-stream',
      () => createToolUseRoundFlow().setServices(services).run(shared),
      { session },
    );
  }

  function createBlankTurnServices(
    responses: Array<{ id: string; text?: string; toolCall?: boolean }>,
  ): {
    createResponse: ReturnType<typeof vi.fn>;
    createUserFollowUpMessages: ReturnType<typeof vi.fn>;
    services: ToolUseRoundServices;
  } {
    const createUserFollowUpMessages = vi.fn(
      async (messages: ProviderMessage[], userMessage: string) =>
        [
          ...messages,
          { type: 'message', role: 'user', content: userMessage },
        ] as ProviderMessage[],
    );
    const createResponse = vi.fn(async () => ({
      response: responses.shift() ?? { id: 'unexpected-blank', text: '' },
    }));
    const createToolUseFollowUpMessages = vi.fn(
      async (_client, call: { callId: string; name: string }) =>
        [
          {
            type: 'function_call',
            call_id: call.callId,
            name: call.name,
            arguments: '{}',
          },
          toolResultMessage(call.callId),
        ] as ProviderMessage[],
    );

    const services = {
      ...baseRoundServices('ToolUseRoundBlankToolResult'),
      modelHandler: roundModelHandler({
        createResponse,
        createToolUseFollowUpMessages,
        createUserFollowUpMessages,
        extractResponse: (response: { text?: string; toolCall?: boolean }) => ({
          text: response.text ?? '',
          usage: null,
          stopReason: response.toolCall ? 'tool_calls' : 'stop',
        }),
        extractToolUse: (response: { toolCall?: boolean }) =>
          response.toolCall
            ? [
                {
                  callId: 'again-1',
                  input: {},
                  name: 'again',
                  provider: 'test',
                  raw: {},
                },
              ]
            : [],
      }),
      session: {
        hasQueuedFollowUp: () => false,
      },
      setting: { temperature: 0, tools: [{ name: 'again' }] },
      toolRegistry: new MapToolRegistry({
        again: {
          call: vi.fn(async () => ({
            status: 'executed',
            output: 'again result',
          })),
          definition: { name: 'again' },
        } as never,
      }),
    } as unknown as ToolUseRoundServices;

    return { createResponse, createUserFollowUpMessages, services };
  }

  it.each([
    { name: 'a tool result', createToolResult: toolResultMessage },
    {
      name: 'an Interactions function_result step',
      createToolResult: interactionsFunctionResultMessage,
    },
    {
      name: 'a VS Code language model tool result',
      createToolResult: vscodeLmToolResultMessage,
    },
  ])(
    'continues when the model returns blank text after $name',
    async ({ createToolResult }) => {
      const { createResponse, createUserFollowUpMessages, services } =
        createBlankTurnServices([
          { id: 'blank', text: '' },
          { id: 'final', text: 'Final answer: 3842.' },
        ]);
      const toolResult = createToolResult('executions-1');
      const shared = createShared([toolResult]);

      await runRound(services, shared);

      expect(createResponse).toHaveBeenCalledTimes(2);
      expect(createUserFollowUpMessages).toHaveBeenCalledWith(
        [toolResult],
        expect.stringContaining('previous assistant turn after a tool result'),
      );
      expect(shared.messages.at(-1)).toEqual({
        type: 'message',
        role: 'assistant',
        content: 'Final answer: 3842.',
      });
      expect(shared.endTurn).toBe(true);
    },
  );

  it('does not retry repeatedly for the same blank tool result', async () => {
    const { createResponse, createUserFollowUpMessages, services } =
      createBlankTurnServices([
        { id: 'blank', text: '' },
        { id: 'still-blank', text: '' },
      ]);
    const shared = createShared([toolResultMessage('executions-1')]);

    await runRound(services, shared);

    expect(createResponse).toHaveBeenCalledTimes(2);
    expect(createUserFollowUpMessages).toHaveBeenCalledTimes(1);
    expect(shared.messages.at(-1)).toEqual(
      expect.objectContaining({ role: 'user' }),
    );
    expect(shared.endTurn).toBe(true);
  });

  it('does not mark a blank tool-result continuation until append succeeds', async () => {
    const { createUserFollowUpMessages, services } = createBlankTurnServices([
      { id: 'blank', text: '' },
    ]);
    const originalToolResult = toolResultMessage('executions-1');
    const shared = createShared([originalToolResult]);

    createUserFollowUpMessages.mockRejectedValueOnce(
      new Error('follow-up append failed'),
    );

    await expect(runRound(services, shared)).rejects.toThrow(
      'follow-up append failed',
    );

    expect(createUserFollowUpMessages).toHaveBeenCalledTimes(1);
    expect(shared.blankToolResultContinuationMessageIndex).toBeUndefined();
    expect(shared.messages).toEqual([originalToolResult]);
  });

  it('retries again for a later blank turn after a different tool result', async () => {
    const { createResponse, createUserFollowUpMessages, services } =
      createBlankTurnServices([
        { id: 'first-blank', text: '' },
        { id: 'tool-call', text: 'checking again', toolCall: true },
        { id: 'second-blank', text: '' },
        { id: 'final', text: 'Final answer after second retry.' },
      ]);
    const shared = createShared([toolResultMessage('executions-1')]);

    await runRound(services, shared);

    expect(createResponse).toHaveBeenCalledTimes(4);
    expect(createUserFollowUpMessages).toHaveBeenCalledTimes(2);
    expect(shared.messages.at(-1)).toEqual({
      type: 'message',
      role: 'assistant',
      content: 'Final answer after second retry.',
    });
    expect(shared.endTurn).toBe(true);
  });

  function createSystemPromptServices(requiresPerCallSystemPrompt: boolean): {
    createResponse: ReturnType<typeof vi.fn>;
    services: ToolUseRoundServices;
  } {
    const createResponse = vi.fn(async () => ({
      response: { id: 'r1', text: 'done' },
    }));

    const services = {
      ...baseRoundServices('ToolUseRoundSystemPrompt'),
      modelHandler: roundModelHandler({
        createResponse,
        extractResponse: (response: { text?: string }) => ({
          text: response.text ?? '',
          usage: null,
          stopReason: 'stop',
        }),
        requiresPerCallSystemPrompt,
      }),
      session: { hasQueuedFollowUp: () => false },
      setting: { temperature: 0, tools: [] },
      toolRegistry: new MapToolRegistry({}),
    } as unknown as ToolUseRoundServices;

    return { createResponse, services };
  }

  it('passes systemPrompt to createResponse when the handler requires it per-call', async () => {
    const { createResponse, services } = createSystemPromptServices(true);
    const shared = createShared([], 'You are a helpful assistant.');

    await runRound(services, shared);

    expect(createResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'You are a helpful assistant.',
      }),
    );
  });

  it('omits systemPrompt from createResponse when the handler embeds it in messages', async () => {
    const { createResponse, services } = createSystemPromptServices(false);
    const shared = createShared([], 'You are a helpful assistant.');

    await runRound(services, shared);

    expect(createResponse).toHaveBeenCalledWith(
      expect.objectContaining({ systemPrompt: undefined }),
    );
  });
});
