import { strict as assert } from 'assert';
import { bus } from '@eventBus/ProgressEventBus';
import { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import {
  AgentSetting,
  AgentPrompt,
  AgentType,
} from '@agent/core/AgentDataclass';
import { ModelProvider, DEFAULT_MODEL_CAPABILITIES } from '@model/ModelConfig';
import type { AgentConfig } from '@agent/core/AgentConfig';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

class DummyHandler extends ModelHandler {
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
  async getClient() {
    return {};
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
  ): Promise<any[]> {
    return [];
  }
  async createRoundMessages(m: any[], u: any): Promise<any[]> {
    m.push({ role: 'user', content: u });
    return m;
  }
  async createUserFollowUpMessages(m: any[], u: any): Promise<any[]> {
    m.push({ role: 'user', content: u });
    return m;
  }
  createAssistantMessage(text: string) {
    return { role: 'assistant', content: text } as any;
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
  createToolUseFollowUpMessages() {
    return [];
  }
}

class TestAgent extends BaseToolUseAgent {}

describe('BaseToolUseAgent follow-up loop', () => {
  it('runs additional cycles for follow-ups', async () => {
    const handler = new DummyHandler();
    const setting: AgentSetting = {
      agentType: AgentType.ToolUse,
      documentTag: 'doc',
      temperature: 0,
      isRewrite: true,
      rounds: 1,
      prefills: [],
      outputExt: 'txt',
      endTag: '</doc>',
      requiredFiles: {},
      requiredFilesInternal: {},
      defaultOutputFiles: [],
      filePatternsContain: [],
      tools: [],
    } as any;
    const prompt: AgentPrompt = {
      systemPrompt: '',
      userPrefix: '',
      userRequest: '',
      userReflect: '',
    };
    const config: AgentConfig = {
      model: 'dummy',
      agent: 'test',
      instruction: '',
      inputFile: '',
      inputFiles: null,
      referenceFile: null,
      referenceFiles: null,
      auxiliaryFile: null,
      auxiliaryFiles: null,
      mediaFile: null,
      mediaFiles: null,
      outputFiles: null,
      editedFile: null,
      toolConfig: {
        reflect: false,
        usePrefillFromInput: false,
        autoExtractFigure: false,
        autoExtractTikzFigure: false,
        attachTeXCount: false,
        attachDiagnostics: false,
        printInputPrompt: false,
        autoCompileInputPdf: false,
      },
    };
    const agent = new TestAgent(handler, config, setting, prompt, '.');
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
