// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - agent
import { noopTrace } from '@agent/trace';
import {
  AgentCategory,
  AgentPromptSchema,
  AgentToolUseSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { MapToolRegistry, type ITool } from '@agent/core/tools/ToolTypes';
import {
  runToolUseFlow,
  type RunToolUseFlowInput,
} from '@agent/implementations/flows/tooluse/runToolUseFlow';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';

// Local imports - shared
import type { ExecutionId, StreamTabId } from '@shared/schemas';

// Test support imports
import { setupPlatform } from '@test/support/setupPlatform';
import { createTestSession } from '@test/support/sessionTestUtils';

const CONFIG = AgentConfigSchema.parse({
  agent: 'chat',
  model: 'test-model',
  instruction: 'Use the supplied tools.',
  agentCategory: AgentCategory.ToolUse,
  workingDirectory: process.cwd(),
  outputSchema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  },
});

function tool(name: string): ITool {
  return {
    definition: { name, description: name, parameters: {} },
    call: vi.fn(),
  };
}

describe('run-scoped tool overlay', () => {
  setupPlatform({ workspacePath: process.cwd() });

  it('adds two injected tools and submit_output to the model-facing list', async () => {
    const executionId = '9329abcd' as ExecutionId;
    const streamId = `chat#${executionId}` as StreamTabId;
    const session = createTestSession();
    const runScope = createRunScope({
      executionId,
      streamId,
      agentName: 'chat',
      session,
    });
    const context = createRunContext({
      modelSource: 'live',
      getModel: () => CONFIG.model,
      runScope,
    });
    const warn = vi.fn<typeof noopTrace.warn>();
    const logger = { ...noopTrace, warn };
    const observedTools: { name: string; forceFunctionCall?: boolean }[][] = [];
    const stopAfterObservation = Object.assign(
      new Error('Tool list observed'),
      {
        status: 401,
      },
    );
    const modelHandler = {
      capabilities: { supportsFunctionCalling: true, supportsVision: false },
      config: { provider: 'test' },
      supportsForcedToolChoice: false,
      requiresPerCallSystemPrompt: false,
      initializeMessages: async () => [{ role: 'user', content: 'test' }],
      consumeInsertedAttachmentKinds: () => [],
      getClient: async () => ({}),
      getCredentialRouteForClient: () => undefined,
      setOutputStreaming: () => {},
      getWireRouteKey: () => 'test',
      getModelRetryRouteKey: () => 'test:model',
      extractAssistantText: () => undefined,
      createResponse: async (options: {
        tools?: { name: string; forceFunctionCall?: boolean }[];
      }) => {
        observedTools.push(options.tools ?? []);
        throw stopAfterObservation;
      },
    } as unknown as RunToolUseFlowInput['modelHandler'];

    try {
      await expect(
        withRunContext(context, () =>
          runToolUseFlow(
            {
              config: CONFIG,
              runScope,
              setting: AgentToolUseSettingSchema.parse({}),
              prompt: AgentPromptSchema.parse({}),
              logger,
              userVarChannels: {
                input: Object.freeze({ MODEL: CONFIG.model }),
                transient: {},
              },
              modelHandler,
              checkInterruption: () => false,
              abortSignal: new AbortController().signal,
              onRoundFinalized: () => {},
              isSubagent: true,
              tools: [tool('first'), tool('second')],
            },
            new MapToolRegistry({ first: tool('first') }),
          ),
        ),
      ).rejects.toThrow('Tool list observed');

      expect(observedTools[0]?.map(({ name }) => name)).toEqual([
        'first',
        'second',
        'submit_output',
      ]);
      expect(
        observedTools[0]?.every(({ forceFunctionCall }) => forceFunctionCall),
      ).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        'Run-scoped tool "first" shadows an existing tool.',
      );
    } finally {
      session.dispose();
    }
  });
});
