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
import { AgentSharedStore } from '@agent/core/AgentSharedStore';
import { AgentRunState, ConversationRoundState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { runToolUseCycle } from '@agent/core/ToolUseCycle';
import type { ToolUseCycleOptions } from '@agent/core/ToolUseCycle';
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { ModelHandlerDeepSeek } from '@agent/modelHandlers/modelHandlerDeepSeek';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

// Internal imports
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES } from '@logger/messageTypes';

// Internal imports
import {
  ModelConfig,
  ModelProvider,
  DEFAULT_MODEL_CAPABILITIES,
} from '@model/ModelConfig';

// Internal imports
import { ToolResult, toolResult } from '@tools/result';

// Internal imports
import { BaseTool } from '@tools/core/base';

// Internal imports
import { bus } from '@eventBus/ProgressEventBus';

// Type imports
import type OpenAI from 'openai';

class EchoTool extends BaseTool<{ value: string }> {
  public readonly calls: Array<{ value: string }> = [];

  constructor() {
    super({ name: 'echo' }, z.object({ value: z.string() }));
  }

  protected async execute(input: { value: string }): Promise<ToolResult> {
    this.calls.push(input);
    return toolResult({ output: input.value });
  }
}

class MockHandler extends ModelHandlerDeepSeek {
  private call = 0;
  async getClient(): Promise<OpenAI> {
    return {} as OpenAI;
  }
  override async createResponse(): Promise<any> {
    this.call++;
    if (this.call === 1) {
      return {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'intro',
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  input: '',
                  function: { name: 'echo', arguments: '{"value":"hello"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    }
    return {
      choices: [
        {
          message: { role: 'assistant', content: 'done' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
  override extractResponse(resp: any): [string, any, any] {
    const text = resp.choices[0].message.content;
    return [text, resp.usage, resp.choices[0].finish_reason];
  }
}

describe('runToolUseCycle DeepSeek', () => {
  it('logs tool calls and creates follow-up message', async () => {
    const config: ModelConfig = {
      name: 'ds',
      fullName: 'ds',
      provider: ModelProvider.DEEPSEEK,
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
    const toolState = new AgentWorkspaceState();
    const options: ToolUseCycleOptions<OpenAI> = {
      modelHandler: handler,
      agentSetting: setting,
      agentPrompt: prompt,
      userVars: {},
      userVarChannels: {
        input: Object.freeze({}) as Readonly<Record<string, any>>,
        transient: {},
        output: {},
      },
      logger,
      client: {} as OpenAI,
      toolRegistry,
      checkInterruption: () => false,
      setAbortController: () => {},
      toolState,
      modelName: 'ds',
      context: new AgentExecutionContext({
        streamId: 'tool-use-stream' as StreamTabId,
      }),
    };
    const store = new AgentSharedStore({
      round: new ConversationRoundState(0),
      run: new AgentRunState(),
      workspace: toolState,
      user: options.userVarChannels,
    });
    const events: any[] = [];
    const dispose = bus.on('addLogMessage', (e) => events.push(e));
    const messages: ProviderMessage[] = [];

    await runToolUseCycle({ options, messages, store });
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
    assert.deepEqual(messages[0], {
      role: 'assistant',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'echo', arguments: '{"value":"hello"}' },
        },
      ],
      content: 'intro',
    });
    assert.deepEqual(messages[1], {
      role: 'tool',
      tool_call_id: 'c1',
      content: JSON.stringify({ output: 'hello' }),
    });
  });

  it('falls back to function.arguments when other fields are empty', async () => {
    class EmptyInputHandler extends MockHandler {
      override extractToolUse(resp: any): string | null {
        const original = super.extractToolUse(resp);
        if (!original) {
          return original;
        }
        const parsed = JSON.parse(original);
        return JSON.stringify({
          ...parsed,
          input: '',
          arguments: '',
          function: {
            name: parsed.name ?? 'echo',
            arguments: '{"value":"fallback"}',
          },
        });
      }
    }

    const config: ModelConfig = {
      name: 'ds',
      fullName: 'ds',
      provider: ModelProvider.DEEPSEEK,
      maxOutputTokens: 10,
      inputPrice: 0,
      outputPrice: 0,
      contextWindow: 1000,
      capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
      openRouterOnly: false,
    };
    const handler = new EmptyInputHandler(config);
    const logger = new AgentLogger('TestHandler', true);
    const tool = new EchoTool();
    const toolRegistry = { echo: tool };
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
    const toolState = new AgentWorkspaceState();
    const options: ToolUseCycleOptions<OpenAI> = {
      modelHandler: handler,
      agentSetting: setting,
      agentPrompt: prompt,
      userVars: {},
      userVarChannels: {
        input: Object.freeze({}) as Readonly<Record<string, any>>,
        transient: {},
        output: {},
      },
      logger,
      client: {} as OpenAI,
      toolRegistry,
      checkInterruption: () => false,
      setAbortController: () => {},
      toolState,
      modelName: 'ds',
      context: new AgentExecutionContext({
        streamId: 'tool-use-deepseek-empty' as StreamTabId,
      }),
    };
    const store = new AgentSharedStore({
      round: new ConversationRoundState(0),
      run: new AgentRunState(),
      workspace: toolState,
      user: options.userVarChannels,
    });
    const events: any[] = [];
    const dispose = bus.on('addLogMessage', (e) => events.push(e));
    const messages: ProviderMessage[] = [];

    await runToolUseCycle({ options, messages, store });
    dispose();

    assert.deepEqual(tool.calls, [{ value: 'fallback' }]);

    const toolEvents = events.filter(
      (e) => e.logMessage.messageType === MESSAGE_TYPES.TOOL_USE,
    );
    assert.equal(toolEvents.length, 2);
    const structuredLog = toolEvents.find(
      (e) => e.logMessage.data && e.logMessage.data.tool === 'echo',
    );
    assert.ok(structuredLog, 'Tool use log entry missing structured payload');
    assert.deepEqual(structuredLog?.logMessage.data?.input, {
      value: 'fallback',
    });
    assert.deepEqual(structuredLog?.logMessage.data?.output, {
      output: 'fallback',
    });
  });

  it('uses args payloads when present on tool calls', async () => {
    class ArgsOnlyHandler extends MockHandler {
      override extractToolUse(resp: any): string | null {
        const original = super.extractToolUse(resp);
        if (!original) {
          return original;
        }
        return JSON.stringify({
          id: 'c1',
          name: 'echo',
          args: { value: 'from-args' },
        });
      }
    }

    const config: ModelConfig = {
      name: 'ds',
      fullName: 'ds',
      provider: ModelProvider.DEEPSEEK,
      maxOutputTokens: 10,
      inputPrice: 0,
      outputPrice: 0,
      contextWindow: 1000,
      capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
      openRouterOnly: false,
    };
    const handler = new ArgsOnlyHandler(config);
    const logger = new AgentLogger('TestHandler', true);
    const tool = new EchoTool();
    const toolRegistry = { echo: tool };
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
    const toolState = new AgentWorkspaceState();
    const options: ToolUseCycleOptions<OpenAI> = {
      modelHandler: handler,
      agentSetting: setting,
      agentPrompt: prompt,
      userVars: {},
      userVarChannels: {
        input: Object.freeze({}) as Readonly<Record<string, any>>,
        transient: {},
        output: {},
      },
      logger,
      client: {} as OpenAI,
      toolRegistry,
      checkInterruption: () => false,
      setAbortController: () => {},
      toolState,
      modelName: 'ds',
      context: new AgentExecutionContext({
        streamId: 'tool-use-deepseek-args' as StreamTabId,
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

    assert.deepEqual(tool.calls, [{ value: 'from-args' }]);
  });
});
