// Node.js built-in imports
import { strict as assert } from 'assert';

// Local imports - agent core
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';
import { AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentPrompt, AgentSetting } from '@agent/core/AgentDataclass';
import { createRunState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import {
  createToolUseCycleFlow,
  type ToolUseCycleShared,
} from '@agent/core/flows/ToolUseCycleFlow';
// Type imports
import type { ToolUseCycleServices } from '@agent/core/flows/CycleServices';

// Local imports - agent runtime
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';
import { noopAgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
// Type imports
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecResult } from '@agent/types/ResultTypes';

// Internal imports
import { MapToolRegistry } from '@agent/core/ToolTypes';
import { AgentLogger } from '@logger/AgentLogger';
import type { StreamTabId } from '@shared/schemas';
import { BashTool } from '@tools/bash';
import * as execUtils from '@utils/system/execUtils';

// Type imports
import type OpenAI from 'openai';

class BashMockHandler extends ModelHandlerOpenAIResponse {
  private callCount = 0;

  async getClient(): Promise<OpenAI> {
    return {} as OpenAI;
  }

  override async createResponse(): Promise<any> {
    this.callCount += 1;
    if (this.callCount === 1) {
      return {
        id: 'bash-call',
        status: 'completed',
        output_text: 'running bash',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'running bash', annotations: [] },
            ],
          },
          {
            type: 'function_call',
            call_id: 'bash-1',
            name: 'bash',
            arguments: '{"command":"echo long"}',
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
    }
    return {
      id: 'bash-complete',
      status: 'completed',
      output_text: 'done',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'done', annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
  }

  override extractResponse(resp: any) {
    if (resp.id === 'bash-call') {
      return {
        text: 'running bash',
        usage: resp.usage,
        stopReason: 'stop',
      };
    }
    if (resp.id === 'bash-complete') {
      return { text: 'done', usage: resp.usage, stopReason: 'stop' };
    }
    return { text: '', usage: resp.usage, stopReason: 'stop' };
  }
}

describe('BashTool', () => {
  const originalExecuteCommand = execUtils.executeCommand;
  const execUtilsMutable = execUtils as unknown as {
    executeCommand: typeof originalExecuteCommand;
  };

  afterEach(() => {
    execUtilsMutable.executeCommand = originalExecuteCommand;
  });

  it('preserves long stdout for tool results and model payloads', async () => {
    const longOutput = '0123456789'.repeat(35); // 350 chars, exceeds log truncation of 150
    const execResult: ExecResult = {
      success: true,
      // executeCommand trims trailing whitespace before returning stdout
      stdout: `${longOutput}\n`.trim(),
      stderr: null,
      timedOut: false,
    };

    execUtilsMutable.executeCommand = async () => execResult;

    const bashTool = new BashTool();
    const directResult = await bashTool.call({ command: 'echo long' });
    assert.equal(
      directResult.output,
      longOutput,
      'Bash tool should return the full stdout text',
    );

    const config: ModelConfig = {
      name: 'test',
      label: 'Test',
      fullName: 'test',
      shortName: 'test',
      provider: ModelProvider.OPENAI,
      maxOutputTokens: 10,
      inputPrice: 0,
      outputPrice: 0,
      contextWindow: 1000,
      capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
      openRouterOnly: false,
    };
    const handler = new BashMockHandler(config);
    const workspaceState = AgentWorkspaceState.create();
    const run = createRunState();
    const options: ToolUseCycleServices<OpenAI> = {
      modelHandler: handler,
      config: config as any,
      setting: {
        agentCategory: AgentCategory.ToolUse,
        documentTag: 'doc',
        temperature: 0,
        endTag: '</doc>',
        requiredFiles: {},
        requiredFilesInternal: {},
        defaultOutputFiles: [],
        filePatternsContain: [],
        tools: [{ name: 'bash' }],
      } satisfies AgentSetting,
      prompt: {
        systemPrompt: '',
        userPrefix: '',
        userRequest: '',
      } satisfies AgentPrompt,
      userVarChannels: { input: {}, transient: {} },
      logger: new AgentLogger('BashToolTest', true),
      runtimeHost: noopAgentRuntimeHost,
      client: {} as OpenAI,
      toolRegistry: new MapToolRegistry({ bash: bashTool }),
      checkInterruption: () => false,
      setAbortController: () => {},
      modelName: 'test',
      streamId: 'bash-tool' as StreamTabId,
      executionId: 'test-execution-id',
      run,
      workspace: workspaceState,
    };

    const messages: ProviderMessage[] = [];

    // Create shared state for the cycle flow (flat pattern)
    // Tool-use cycles track metrics in shared (cycleIndex, etc.) instead of round object
    const shared: ToolUseCycleShared = {
      messages,
      shouldStop: false,
      endTurn: false,
      response: undefined,
      responseTimeMs: undefined,
      stopReason: undefined,
      lastError: undefined,
      toolCalls: undefined,
      text: undefined,
      cycleIndex: 0,
      cycleResponseTimeMs: 0,
      cycleNormalizedUsage: undefined,
    };

    // Create and run the flow directly
    const flow = createToolUseCycleFlow();
    flow.setServices(options);
    await flow.run(shared);

    const toolOutputMessage = messages.find(
      (msg) => (msg as any).type === 'function_call_output',
    ) as any;
    assert.ok(toolOutputMessage, 'Tool output message was not produced');
    assert.ok(
      typeof toolOutputMessage.output === 'string' &&
        toolOutputMessage.output.includes(longOutput),
      'Model follow-up payload should contain the complete stdout text',
    );
  });
});
