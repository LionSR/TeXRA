import { describe, expect, it, vi } from 'vitest';

import { noopTrace } from '@agent/trace';
import type { AgentCore, ToolPolicy } from '@agent/core/flows/BaseFlowServices';
import type { BaseCycleFields } from '@agent/core/flows/CommonCycleTypes';
import type { ResponseCycleServices } from '@agent/core/flows/CycleServices';
import { ModelInvocationNode } from '@agent/core/flows/ModelInvocationNode';
import { responseCycleToolsForModel } from '@agent/implementations/flows/reflection/ResponseCycleFlow';
import { getDefaultToolRegistry } from '@tools/registry';
import { testRunScope, withTestRunContext } from './progressTestUtils';
import { testModelCell } from './modelCellTestUtils';

function toolNames(tools: readonly { name: string }[] | undefined): string[] {
  return tools?.map((tool) => tool.name) ?? [];
}

function responseServices({
  supportsFunctionCalling = true,
  toolPolicy = {},
}: {
  supportsFunctionCalling?: boolean;
  toolPolicy?: ToolPolicy;
} = {}): Parameters<typeof responseCycleToolsForModel>[0] {
  return {
    toolRegistry: getDefaultToolRegistry(),
    toolPolicy,
    modelCell: testModelCell({
      config: { provider: 'openai', fullName: 'test-model' },
      getClient: async () => ({}),
      getCredentialRouteForClient: () => undefined,
      getWireRouteKey: () => 'openai:test-route',
      getModelRetryRouteKey: () => 'openai:test-route:model',
      capabilities: { supportsFunctionCalling },
    }),
    setting: {
      tools: [
        { name: 'bash' },
        { name: 'grep' },
        { name: 'inquiry' },
        { name: 'write_file' },
        { name: 'wolfram' },
      ],
    },
  } as unknown as ResponseCycleServices;
}

describe('response cycle tool visibility', () => {
  it.each([
    {
      name: 'filters approval-gated workflow tools when prompts are unavailable',
      toolPolicy: { approvalPromptsUnavailable: true },
      expected: ['grep'],
    },
    {
      name: 'keeps workflow tools when approval prompts are available',
      toolPolicy: { approvalPromptsUnavailable: false },
      expected: ['bash', 'grep', 'inquiry', 'write_file', 'wolfram'],
    },
    {
      name: 'filters runtime-unavailable workflow tools without hiding approvals',
      toolPolicy: {
        approvalPromptsUnavailable: false,
        runtimeUnavailableTools: ['inquiry'],
      },
      expected: ['bash', 'grep', 'write_file', 'wolfram'],
    },
  ])('$name', ({ toolPolicy, expected }) => {
    // No AsyncLocalStorage frame is installed: the tool policy is read from
    // the injected `services.toolPolicy`, not from the ambient RunContext.
    const tools = responseCycleToolsForModel(responseServices({ toolPolicy }));

    expect(toolNames(tools)).toEqual(expected);
  });

  it('omits workflow tools when the model handler cannot call functions', () => {
    const tools = responseCycleToolsForModel(
      responseServices({ supportsFunctionCalling: false }),
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
      config: {},
      logger: noopTrace,
      modelCell: testModelCell({
        config: { provider: 'openai', fullName: 'test-model' },
        createResponse,
        getClient: async () => ({}),
        getCredentialRouteForClient: () => undefined,
        getWireRouteKey: () => 'openai:test-route',
        getModelRetryRouteKey: () => 'openai:test-route:model',
        isBackgroundModeActive: () => false,
        setOutputStreaming: vi.fn(),
      }),
      runScope: testRunScope('response-cycle-invocation'),
      setting: {
        temperature: 0,
        tools: [{ name: 'bash' }],
      },
    } as unknown as AgentCore);

    await withTestRunContext(node.services.runScope, () =>
      node.run({
        messages: [],
        shouldStop: false,
      } as unknown as BaseCycleFields),
    );

    expect(createResponse).toHaveBeenCalledWith(
      expect.objectContaining({ tools: undefined }),
    );
  });
});
