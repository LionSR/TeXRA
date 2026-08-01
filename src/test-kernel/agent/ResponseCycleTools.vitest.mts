import { describe, expect, it, vi } from 'vitest';

import { ModelInvocationNode } from '@agent/core/flows/ModelInvocationNode';
import { responseCycleToolsForModel } from '@agent/core/flows/ResponseCycleFlow';
import { getDefaultToolRegistry } from '@tools/registry';
import { testRunScope, withTestRunContext } from './progressTestUtils';

function toolNames(tools: readonly { name: string }[] | undefined): string[] {
  return tools?.map((tool) => tool.name) ?? [];
}

function responseServices({
  supportsFunctionCalling = true,
}: {
  supportsFunctionCalling?: boolean;
}) {
  return {
    toolRegistry: getDefaultToolRegistry(),
    modelHandler: {
      config: { provider: 'openai', fullName: 'test-model' },
      getWireRouteKey: () => 'openai:test-route',
      getModelRetryRouteKey: () => 'openai:test-route:model',
      capabilities: { supportsFunctionCalling },
    },
    setting: {
      tools: [
        { name: 'bash' },
        { name: 'grep' },
        { name: 'inquiry' },
        { name: 'write_file' },
        { name: 'wolfram' },
      ],
    },
  };
}

describe('response cycle tool visibility', () => {
  it.each([
    {
      name: 'filters approval-gated workflow tools when prompts are unavailable',
      services: { approvalPromptsUnavailable: true },
      expected: ['grep'],
    },
    {
      name: 'keeps workflow tools when approval prompts are available',
      services: { approvalPromptsUnavailable: false },
      expected: ['bash', 'grep', 'inquiry', 'write_file', 'wolfram'],
    },
    {
      name: 'filters runtime-unavailable workflow tools without hiding approvals',
      services: {
        approvalPromptsUnavailable: false,
        runtimeUnavailableTools: ['inquiry'],
      },
      expected: ['bash', 'grep', 'write_file', 'wolfram'],
    },
  ])('$name', async ({ services, expected }) => {
    const tools = await withTestRunContext(
      { emit: vi.fn() },
      'response-cycle-stream',
      async () => responseCycleToolsForModel(responseServices({}) as any),
      services,
    );

    expect(toolNames(tools)).toEqual(expected);
  });

  it('omits workflow tools when the model handler cannot call functions', async () => {
    const tools = await withTestRunContext(
      { emit: vi.fn() },
      'response-cycle-stream',
      async () =>
        responseCycleToolsForModel(
          responseServices({
            supportsFunctionCalling: false,
          }) as any,
        ),
    );

    expect(tools).toBeUndefined();
  });

  it('honors an explicit getTools result even when it is undefined', async () => {
    const createResponse = vi.fn().mockResolvedValue({
      response: { text: 'ok' },
      updatedMessages: [],
    });
    const node = new ModelInvocationNode({
      operationName: 'test invocation',
      streaming: false,
      getTools: () => undefined,
      storeResponse: (shared, response) => {
        (shared as { responseObject?: unknown }).responseObject = response;
      },
    });
    node.setServices({
      client: {},
      config: {},
      logger: { debug: vi.fn(), warn: vi.fn() },
      modelHandler: {
        config: { provider: 'openai', fullName: 'test-model' },
        createResponse,
        getWireRouteKey: () => 'openai:test-route',
        getModelRetryRouteKey: () => 'openai:test-route:model',
        isBackgroundModeActive: () => false,
        setOutputStreaming: vi.fn(),
      },
      runScope: testRunScope('response-cycle-invocation'),
      interactions: { emit: vi.fn() },
      abortSignal: new AbortController().signal,
      setting: {
        temperature: 0,
        tools: [{ name: 'bash' }],
      },
      streamId: 'stream-1',
    } as any);

    await withTestRunContext(
      { emit: vi.fn() },
      'response-cycle-invocation',
      () =>
        node.run({
          messages: [],
          shouldStop: false,
        } as any),
    );

    expect(createResponse).toHaveBeenCalledWith(
      expect.objectContaining({ tools: undefined }),
    );
  });
});
