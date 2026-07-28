// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - agent
import { noopTrace } from '@agent/trace';
import {
  AgentCategory,
  AgentPromptSchema,
  AgentToolUseSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { MapToolRegistry, type ITool } from '@agent/core/tools/ToolTypes';
import {
  runToolUseFlow,
  type RunToolUseFlowInput,
} from '@agent/implementations/flows/tooluse/runToolUseFlow';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { createRunScope } from '@agent/runtime/RunScope';

// Local imports - shared
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

// Test support imports
import { setupPlatform } from '@test/support/setupPlatform';
import { createTestSession } from '@test/support/sessionTestUtils';

const CONFIG: AgentConfig = {
  inputFiles: [],
  contextFiles: [],
  mediaFiles: [],
  outputFiles: [],
  editedFile: null,
  agent: 'chat',
  model: 'test-model',
  instruction: 'Use the supplied tools.',
  agentCategory: AgentCategory.ToolUse,
  editedFiles: [],
  toolConfig: DEFAULT_TOOL_CONFIG,
  memories: [],
  workingDirectory: process.cwd(),
  cliOutputFile: null,
  cliMultiAgentPresetId: null,
  outputSchema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  },
};

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
    const observedToolNames: string[][] = [];
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
      createResponse: async (options: { tools?: { name: string }[] }) => {
        observedToolNames.push(options.tools?.map(({ name }) => name) ?? []);
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
              setAbortController: () => {},
              onRoundFinalized: () => {},
              isSubagent: true,
              tools: [tool('first'), tool('second')],
            },
            new MapToolRegistry({ first: tool('first') }),
          ),
        ),
      ).rejects.toThrow('Tool list observed');

      expect(observedToolNames).toEqual([['first', 'second', 'submit_output']]);
      expect(warn).toHaveBeenCalledWith(
        'Run-scoped tool "first" shadows an existing tool.',
      );
    } finally {
      session.dispose();
    }
  });
});
