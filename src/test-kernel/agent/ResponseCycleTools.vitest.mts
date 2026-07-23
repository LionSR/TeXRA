import { describe, expect, it, vi } from 'vitest';

import { ModelInvocationNode } from '@agent/core/flows/ModelInvocationNode';
import { responseCycleToolsForModel } from '@agent/core/flows/ResponseCycleFlow';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import { getDefaultToolRegistry } from '@tools/registry';
import { withTestRunContext } from './progressTestUtils';

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

function withResponseRunContext<T>(
  options: {
    approvalPromptsUnavailable?: boolean;
    runtimeUnavailableTools?: readonly string[];
  },
  fn: () => T,
): T {
  return withRunContext(
    createRunContext({
      runScope: createRunScope({
        runtimeHost: { emit: vi.fn() },
        streamId: 'response-cycle-stream',
        executionId: 'response-cycle-execution',
        agentName: 'response-agent',
        session: {} as any,
      }),
      modelSource: 'live',
      getModel: () => 'deepseekT',
      ...options,
    }),
    fn,
  ) as T;
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
  ])('$name', ({ services, expected }) => {
    const tools = withResponseRunContext(services, () =>
      responseCycleToolsForModel(responseServices({}) as any),
    );

    expect(toolNames(tools)).toEqual(expected);
  });

  it('omits workflow tools when the model handler cannot call functions', () => {
    const tools = withResponseRunContext({}, () =>
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
      runtimeHost: { emit: vi.fn() },
      setAbortController: vi.fn(),
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
