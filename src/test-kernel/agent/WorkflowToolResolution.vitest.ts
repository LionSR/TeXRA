import { afterEach, describe, expect, it, vi } from 'vitest';

import { noopTrace } from '@agent/trace';
import { createToolPolicy } from '@agent/core/flows/BaseFlowServices';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import {
  AgentPromptSchema,
  AgentWorkflowSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { runReflectionFlow } from '@agent/implementations/flows/reflection/runReflectionFlow';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';
import { SharedToolInjectionRegistry } from '@agent/runtime/toolInjection';
import {
  AgentCategory,
  type ExecutionId,
  type StreamTabId,
  type ToolDefinition,
} from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { getDefaultToolRegistry } from '@tools/registry';
import { testModelCell } from './modelCellTestUtils';

const CONFIG = AgentConfigSchema.parse({
  agent: 'workflow-tool-resolution',
  model: 'test-model',
  instruction: 'Use the declared tools.',
  agentCategory: AgentCategory.Workflow,
  workingDirectory: process.cwd(),
});
const PROMPT = AgentPromptSchema.parse({ userRequest: 'Start the workflow.' });

setupPlatform({ workspacePath: process.cwd() });
afterEach(() => vi.restoreAllMocks());

/**
 * Capture the tools at the real reflection model-invocation boundary, then
 * stop the run before response processing so each case only exercises tool
 * resolution and provider request assembly.
 */
function stopAfterToolObservationHandler(
  observedTools: ToolDefinition[][],
  supportsFunctionCalling: boolean,
) {
  const stopAfterObservation = Object.assign(new Error('Tool list observed'), {
    status: 401,
  });
  return {
    capabilities: { supportsFunctionCalling },
    config: { provider: 'test' },
    initializeMessages: async () => [
      { role: 'user' as const, content: 'test' },
    ],
    initializeOutputAndPrefill: async () => [false, []] as const,
    getClient: async () => ({}),
    getCredentialRouteForClient: () => undefined,
    isBackgroundModeActive: () => false,
    setOutputStreaming: () => {},
    getWireRouteKey: () => 'test',
    getModelRetryRouteKey: () => 'test:model',
    createResponse: async (options: { tools?: ToolDefinition[] }) => {
      observedTools.push(options.tools ?? []);
      throw stopAfterObservation;
    },
  };
}

async function observeWorkflowTools({
  setting,
  supportsFunctionCalling,
  approvalPromptsUnavailable = false,
  runtimeUnavailableTools,
  warn,
}: {
  setting: ReturnType<typeof AgentWorkflowSettingSchema.parse>;
  supportsFunctionCalling: boolean;
  approvalPromptsUnavailable?: boolean;
  runtimeUnavailableTools?: readonly string[];
  warn: typeof noopTrace.warn;
}): Promise<ToolDefinition[][]> {
  const executionId = `workflow-tools-${crypto.randomUUID()}` as ExecutionId;
  const streamId = `workflow-tools@stream#${executionId}` as StreamTabId;
  const session = createTestSession();
  const runScope = createRunScope({
    executionId,
    streamId,
    agentName: CONFIG.agent,
    session,
    signal: new AbortController().signal,
  });
  const observedTools: ToolDefinition[][] = [];
  const modelCell = testModelCell(
    stopAfterToolObservationHandler(observedTools, supportsFunctionCalling),
    CONFIG.model,
  );
  const logger = { ...noopTrace, warn };

  try {
    const result = await withRunContext(
      createRunContext({ runScope, modelCell }),
      () =>
        runReflectionFlow({
          config: CONFIG,
          runScope,
          setting,
          prompt: PROMPT,
          logger,
          parentStage: noopTrace.openStage('Workflow tool resolution test'),
          userVarChannels: { MODEL: CONFIG.model },
          modelCell,
          toolPolicy: createToolPolicy({
            approvalPromptsUnavailable,
            runtimeUnavailableTools,
          }),
          onRoundFinalized: () => {},
        }),
    );

    expect(result.outcome).toBe('failed');
    expect(result.error?.message).toContain('Tool list observed');
    return observedTools;
  } finally {
    session.dispose();
  }
}

describe('workflow tool resolution', () => {
  it('passes canonical filtered registry contracts to the reflection handler', async () => {
    const warn = vi.fn<typeof noopTrace.warn>();
    const sharedInjections = vi.spyOn(SharedToolInjectionRegistry, 'list');
    sharedInjections.mockReturnValue([
      { toolName: 'plan', shouldInject: () => true },
    ]);
    const setting = AgentWorkflowSettingSchema.parse({
      rounds: 1,
      tools: [
        { name: 'grep' },
        { name: 'bash' },
        { name: 'inquiry' },
        { name: 'missing_workflow_tool' },
      ],
    });

    const observedTools = await observeWorkflowTools({
      setting,
      supportsFunctionCalling: true,
      approvalPromptsUnavailable: true,
      runtimeUnavailableTools: ['inquiry'],
      warn,
    });

    expect(observedTools).toEqual([
      [getDefaultToolRegistry().get('grep')?.definition],
    ]);
    expect(warn).toHaveBeenCalledWith(
      'Declared tool not found in registry: missing_workflow_tool',
    );
    expect(sharedInjections).not.toHaveBeenCalled();
  });

  it('passes no tools to a model without function calling', async () => {
    const observedTools = await observeWorkflowTools({
      setting: AgentWorkflowSettingSchema.parse({
        rounds: 1,
        tools: [{ name: 'grep' }],
      }),
      supportsFunctionCalling: false,
      warn: vi.fn<typeof noopTrace.warn>(),
    });

    expect(observedTools).toEqual([[]]);
  });
});
