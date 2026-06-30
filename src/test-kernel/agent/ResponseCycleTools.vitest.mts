import { describe, expect, it, vi } from 'vitest';

import { ModelInvocationNode } from '@agent/core/flows/ModelInvocationNode';
import { responseCycleToolsForModel } from '@agent/core/flows/ResponseCycleFlow';

function toolNames(tools: readonly { name: string }[] | undefined): string[] {
  return tools?.map((tool) => tool.name) ?? [];
}

function responseServices({
  approvalPromptsUnavailable,
  runtimeUnavailableTools,
  supportsFunctionCalling = true,
}: {
  approvalPromptsUnavailable?: boolean;
  runtimeUnavailableTools?: readonly string[];
  supportsFunctionCalling?: boolean;
}) {
  return {
    approvalPromptsUnavailable,
    runtimeUnavailableTools,
    modelHandler: {
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
  ])('$name', ({ services, expected }) => {
    const tools = responseCycleToolsForModel(responseServices(services) as any);

    expect(toolNames(tools)).toEqual(expected);
  });

  it('omits workflow tools when the model handler cannot call functions', () => {
    const tools = responseCycleToolsForModel(
      responseServices({
        supportsFunctionCalling: false,
      }) as any,
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
        createResponse,
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

    await node.run({
      messages: [],
      shouldStop: false,
    } as any);

    expect(createResponse).toHaveBeenCalledWith(
      expect.objectContaining({ tools: undefined }),
    );
  });
});
