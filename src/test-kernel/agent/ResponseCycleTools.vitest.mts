import { describe, expect, it, vi } from 'vitest';

import { ModelInvocationNode } from '@agent/core/flows/ModelInvocationNode';
import { responseCycleToolsForModel } from '@agent/core/flows/ResponseCycleFlow';

function toolNames(tools: readonly { name: string }[] | undefined): string[] {
  return tools?.map((tool) => tool.name) ?? [];
}

function responseServices({
  approvalPromptsUnavailable,
  supportsFunctionCalling = true,
}: {
  approvalPromptsUnavailable?: boolean;
  supportsFunctionCalling?: boolean;
}) {
  return {
    approvalPromptsUnavailable,
    modelHandler: {
      capabilities: { supportsFunctionCalling },
    },
    setting: {
      tools: [
        { name: 'bash' },
        { name: 'grep' },
        { name: 'write_file' },
        { name: 'wolfram' },
      ],
    },
  };
}

describe('response cycle tool visibility', () => {
  it('filters approval-gated workflow tools when prompts are unavailable', () => {
    const tools = responseCycleToolsForModel(
      responseServices({
        approvalPromptsUnavailable: true,
      }) as any,
    );

    expect(toolNames(tools)).toEqual(['grep', 'wolfram']);
  });

  it('keeps workflow tools when approval prompts are available', () => {
    const tools = responseCycleToolsForModel(
      responseServices({
        approvalPromptsUnavailable: false,
      }) as any,
    );

    expect(toolNames(tools)).toEqual(['bash', 'grep', 'write_file', 'wolfram']);
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
