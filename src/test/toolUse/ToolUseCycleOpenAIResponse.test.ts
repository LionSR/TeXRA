// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import { z } from 'zod';

// Local imports - test
import {
  AgentSetting,
  AgentType,
  AgentPrompt,
  AgentCategory,
} from '@agent/core/AgentDataclass';
import { ToolState } from '@agent/core/ToolState';
import { runToolUseCycle } from '@agent/core/ToolUseCycle';
import type { ToolUseCycleOptions } from '@agent/core/ToolUseCycle';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

// Local imports
import { bus } from '@eventBus/ProgressEventBus';
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';
import { AgentLogScopeManager } from '@agent/runtime/AgentLogScopeManager';
import type { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import type { AgentUsageReporter } from '@logger/AgentUsageReporter';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import {
  ModelConfig,
  ModelProvider,
  DEFAULT_MODEL_CAPABILITIES,
} from '@model/ModelConfig';
import { BaseTool } from '@tools/core/base';
import { ToolResult, toolResult } from '@tools/result';
import type OpenAI from 'openai';

class EchoTool extends BaseTool<{ value: string }> {
  constructor() {
    super({ name: 'echo' }, z.object({ value: z.string() }));
  }
  protected async execute(input: { value: string }): Promise<ToolResult> {
    return toolResult({ output: input.value });
  }
}

class MockHandler extends ModelHandlerOpenAIResponse {
  private call = 0;
  async getClient(): Promise<OpenAI> {
    return {} as OpenAI;
  }
  override async createResponse(): Promise<any> {
    this.call++;
    if (this.call === 1) {
      return {
        id: 'r1',
        status: 'completed',
        output_text: 'intro',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'intro', annotations: [] }],
          },
          {
            type: 'function_call',
            call_id: 'c1',
            name: 'echo',
            arguments: '{"value":"hello"}',
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
    }
    return {
      id: 'r2',
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
    if (resp.id === 'r1') {
      return ['intro', resp.usage, 'stop'];
    }
    if (resp.id === 'r2') {
      return ['done', resp.usage, 'stop'];
    }
    return ['', resp.usage, 'stop'];
  }
}

function createExecutionContextStub(logger: AgentLogger): AgentExecutionContext {
  const logScopes = new AgentLogScopeManager(logger);
  return {
    logger,
    usageReporter: {} as AgentUsageReporter,
    logScopes,
    get streamId() {
      return 'tool-use-test' as StreamTabId;
    },
    get executionId() {
      return undefined;
    },
  } as AgentExecutionContext;
}

describe('runToolUseCycle OpenAIResponse', () => {
  it('logs tool calls and creates follow-up message', async () => {
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
    const handler = new MockHandler(config);
    const logger = new AgentLogger('TestHandler', true);
    const toolRegistry = { echo: new EchoTool() };
    const setting: AgentSetting = {
      agentType: AgentType.ToolUse,
      agentCategory: AgentCategory.ToolUse,
      documentTag: 'doc',
      temperature: 0,
      endTag: '</doc>',
      requiredFiles: {},
      requiredFilesInternal: {},
      defaultOutputFiles: [],
      filePatternsContain: [],
      tools: [{ name: 'echo' }],
    };
    const prompt: AgentPrompt = {
      systemPrompt: '',
      userPrefix: '',
      userRequest: '',
    };
    const toolState = new ToolState();
    const options: ToolUseCycleOptions<OpenAI> = {
      modelHandler: handler,
      agentSetting: setting,
      agentPrompt: prompt,
      userVars: {},
      context: createExecutionContextStub(logger),
      client: {} as OpenAI,
      toolRegistry,
      checkInterruption: () => false,
      setAbortController: () => {},
      toolState,
      modelName: 'test',
    };
    const events: any[] = [];
    const dispose = bus.on('addLogMessage', (e) => events.push(e));
    const messages: ProviderMessage[] = [];

    await runToolUseCycle({ options, messages });
    dispose();

    const toolEvents = events.filter(
      (e) => e.logMessage.messageType === MESSAGE_TYPES.TOOL_USE,
    );
    assert.equal(toolEvents.length, 2);
    const structuredLog = toolEvents.find(
      (e) => e.logMessage.data && e.logMessage.data.tool === 'echo',
    );
    assert.ok(structuredLog, 'Tool use log entry missing structured payload');
    assert.deepEqual(structuredLog?.logMessage.data?.input, { value: 'hello' });
    assert.deepEqual(structuredLog?.logMessage.data?.output, {
      output: 'hello',
    });
    const assistantMsg = messages[0] as any;
    assert.equal(assistantMsg.role, 'assistant');
    assert.equal(assistantMsg.type, 'message');
    assert.equal(assistantMsg.status, 'completed');
    assert.ok(Array.isArray(assistantMsg.content));
    assert.equal(assistantMsg.content[0].type, 'output_text');
    assert.equal(assistantMsg.content[0].text, 'intro');
    assert.deepEqual(messages[1], {
      type: 'function_call',
      call_id: 'c1',
      name: 'echo',
      arguments: '{"value":"hello"}',
    });
    assert.deepEqual(messages[2], {
      type: 'function_call_output',
      call_id: 'c1',
      output: JSON.stringify({ output: 'hello' }),
    });
  });
});
