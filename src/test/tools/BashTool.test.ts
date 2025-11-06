import { strict as assert } from 'assert';

// Third-party imports
import type OpenAI from 'openai';

// Local imports - agent core
import {
  AgentCategory,
  AgentPrompt,
  AgentSetting,
  AgentType,
} from '@agent/core/AgentDataclass';
import { AgentSharedStore } from '@agent/core/AgentSharedStore';
import { AgentRunState, ConversationRoundState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { runToolUseCycle } from '@agent/core/ToolUseCycle';
import type { ToolUseCycleOptions } from '@agent/core/ToolUseCycle';

// Local imports - agent runtime
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';

// Local imports - agent model handlers
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

// Local imports - model
import {
  DEFAULT_MODEL_CAPABILITIES,
  ModelConfig,
  ModelProvider,
} from '@model/ModelConfig';

// Local imports - tools
import { BashTool } from '@tools/bash';

// Local imports - utilities
import type { ExecResult } from '@agent/types/ResultTypes';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import * as execUtils from '@utils/system/execUtils';
import { AgentLogger } from '@logger/AgentLogger';

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

  override extractResponse(resp: any): [string, any, any] {
    if (resp.id === 'bash-call') {
      return ['running bash', resp.usage, 'stop'];
    }
    if (resp.id === 'bash-complete') {
      return ['done', resp.usage, 'stop'];
    }
    return ['', resp.usage, 'stop'];
  }
}

suite('BashTool', () => {
  const originalExecuteCommand = execUtils.executeCommand;
  const execUtilsMutable = execUtils as unknown as {
    executeCommand: typeof originalExecuteCommand;
  };

  teardown(() => {
    execUtilsMutable.executeCommand = originalExecuteCommand;
  });

  test('preserves long stdout for tool results and model payloads', async () => {
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
      fullName: 'test',
      provider: ModelProvider.OPENAI,
      maxOutputTokens: 10,
      inputPrice: 0,
      outputPrice: 0,
      contextWindow: 1000,
      capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
      openRouterOnly: false,
    };
    const handler = new BashMockHandler(config);
    const toolState = new AgentWorkspaceState();
    const options: ToolUseCycleOptions<OpenAI> = {
      modelHandler: handler,
      agentSetting: {
        agentType: AgentType.ToolUse,
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
      agentPrompt: {
        systemPrompt: '',
        userPrefix: '',
        userRequest: '',
      } satisfies AgentPrompt,
      userVars: {},
      userVarChannels: {
        input: Object.freeze({}) as Readonly<Record<string, any>>,
        transient: {},
        output: {},
      },
      logger: new AgentLogger('BashToolTest', true),
      client: {} as OpenAI,
      toolRegistry: { bash: bashTool },
      checkInterruption: () => false,
      setAbortController: () => {},
      toolState,
      modelName: 'test',
      context: new AgentExecutionContext({
        streamId: 'bash-tool' as StreamTabId,
      }),
    };

    const store = new AgentSharedStore({
      round: new ConversationRoundState(0),
      run: new AgentRunState(),
      workspace: toolState,
      user: options.userVarChannels,
    });

    const messages: ProviderMessage[] = [];
    await runToolUseCycle({ options, messages, store });

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
