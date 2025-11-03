// Standard library imports
import { strict as assert } from 'assert';

// Local imports - test
import { parseAgentConfig, type AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSetting,
  AgentPrompt,
  AgentType,
  AgentCategory,
} from '@agent/core/AgentDataclass';
import { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
import type { StreamTabId } from '@agent/types/IdentifierTypes';
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import { bus } from '@eventBus/ProgressEventBus';
import { ModelProvider, DEFAULT_MODEL_CAPABILITIES } from '@model/ModelConfig';
import { ToolRuntimeState } from '@agent/core/ToolRuntimeState';

type DummyClient = Record<string, never>;

class DummyHandler extends ModelHandler<
  ProviderMessage,
  unknown,
  unknown,
  unknown,
  DummyClient
> {
  calls = 0;
  constructor() {
    super({
      name: 'dummy',
      fullName: 'dummy',
      provider: ModelProvider.OPENAI,
      maxOutputTokens: 10,
      inputPrice: 0,
      outputPrice: 0,
      contextWindow: 1000,
      capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
      openRouterOnly: false,
    });
  }
  async getClient(): Promise<DummyClient> {
    return {} as DummyClient;
  }
  async createResponse(): Promise<any> {
    this.calls++;
    return {};
  }
  async initializeMessages(
    _: any,
    __: any,
    ___?: any,
    ____?: any,
  ): Promise<ProviderMessage[]> {
    return [];
  }
  async createRoundMessages(
    m: ProviderMessage[],
    u: string,
  ): Promise<ProviderMessage[]> {
    m.push({ role: 'user', content: u });
    return m;
  }
  async createUserFollowUpMessages(
    m: ProviderMessage[],
    u: string,
  ): Promise<ProviderMessage[]> {
    m.push({ role: 'user', content: u });
    return m;
  }
  createAssistantMessage(text: string): ProviderMessage {
    return { role: 'assistant', content: text } as ProviderMessage;
  }
  isEndTurnStop(_r: any): boolean {
    return false;
  }
  createMediaContent() {
    return [];
  }
  extractResponse(): [string, any, any] {
    return ['', null, 'stop'];
  }
  addContinueMessageWithPrefill() {}
  addContinueMessageWithoutPrefill() {}
  initializeOutputAndPrefill(): Promise<[boolean, any[]]> {
    return Promise.resolve([true, []]);
  }
  computePrice() {
    return 0;
  }
  computeResponseUsage() {
    return {};
  }
  updateMessageContentWithPrefill() {}
  updateMessageContentWithoutPrefill() {}
  shouldContinue() {
    return false;
  }
  checkStopConditions(): [boolean, boolean] {
    return [true, true];
  }
  processThinkingBlock() {
    return null;
  }
  extractToolUse() {
    return null;
  }
  async createToolUseFollowUpMessages(
    _client: DummyClient | undefined,
    _id: string,
    _name: string,
    _call: unknown,
    _result: Record<string, unknown>,
    _toolState?: ToolRuntimeState,
    _text?: string,
  ): Promise<ProviderMessage[]> {
    return [];
  }
}

class TestAgent extends BaseToolUseAgent {}

describe('BaseToolUseAgent follow-up loop', () => {
  it('runs additional cycles for follow-ups', async () => {
    const handler = new DummyHandler();
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
      tools: [],
    };
    const prompt: AgentPrompt = {
      systemPrompt: '',
      userPrefix: '',
      userRequest: '',
    };
    const config: AgentConfig = parseAgentConfig({
      model: 'dummy',
      agent: 'test',
      instruction: '',
      useMultipleOutputs: false,
      inputFile: '',
      toolConfig: {
        autoExtractFigure: false,
        autoExtractTikzFigure: false,
        attachTeXCount: false,
        attachDiagnostics: false,
        autoCompileInputPdf: false,
      },
    });
    const agent = new TestAgent(
      handler,
      config,
      setting,
      prompt,
      '.',
      new AgentExecutionContext({ streamId: 'test-stream' as StreamTabId }),
    );
    const logs: any[] = [];
    const dispose = bus.on('addLogMessage', (e) => logs.push(e));
    const runPromise = agent.run();
    agent.appendFollowUp('one');
    agent.appendFollowUp('two');
    setTimeout(() => agent.interrupt(), 10);
    await runPromise;
    dispose();
    assert.equal(handler.calls, 3);
    assert.ok(logs.length > 0);
  });
});
