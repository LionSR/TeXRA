// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentType, AgentCategory } from '@agent/core/AgentDataclass';
import type { AgentPrompt, AgentSetting } from '@agent/core/AgentDataclass';
import { BaseAgent } from '@agent/implementations/BaseAgent';
import type { IModelHandler } from '@agent/modelHandlers';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';
import { MCP_STOP } from '@agent/modelHandlers/types/StopReasonTypes';
import { createAgentRunContext } from '@agent/runtime/AgentRunContext';
import type { AgentRunContext } from '@agent/runtime/AgentRunContext';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';
import type { ModelConfig, ModelCapabilities } from '@model/ModelConfig';
import { ModelProvider, ReasoningEffort } from '@model/ModelConfig';
import { DEFAULT_TOOL_CONFIG } from '@agent/core/ToolConfig';

class StubModelHandler implements IModelHandler {
  public config: ModelConfig;
  public capabilities: ModelCapabilities;
  public continueLimit = 0;
  public inputTokenLimit = 0;
  public maxOutputTokensFactor = 0;
  public isOpenai = false;
  public isAnthropic = false;
  public isGoogle = false;
  public isOpenaiCompatible = false;
  public appliedContext: AgentRunContext | undefined;
  public lastLoggerId: string | undefined;
  private agentType?: AgentType;

  constructor() {
    this.capabilities = {
      supportsFunctionCalling: false,
      supportsNativeMCPServer: false,
      supportsNativeWebSearch: false,
      supportsNativeCodeExecution: false,
      supportsPromptCaching: false,
      supportsAutoPromptCaching: false,
      cacheDiscountFactor: 0,
      supportsReasoning: false,
      supportsInterleavedThinking: false,
      reasoningEffort: ReasoningEffort.NONE,
      supportsVision: false,
      supportsNativePdf: false,
      supportsAssistantPrefill: false,
      supportsPredictiveOutput: false,
      supportsTokenCounting: false,
      supportsSystemPrompt: true,
      supportsIntermDevMsgs: false,
      supportsReasoningEffort: false,
      supportsNativeAudio: false,
    };

    this.config = {
      name: 'test-model',
      fullName: 'test-model-full',
      provider: ModelProvider.ANTHROPIC,
      maxOutputTokens: 1,
      inputPrice: 0,
      outputPrice: 0,
      contextWindow: 1,
      capabilities: this.capabilities,
      openRouterOnly: false,
      toolConfig: DEFAULT_TOOL_CONFIG,
    } as ModelConfig;
  }

  public applyRunContext(context: AgentRunContext): void {
    this.appliedContext = context;
    this.lastLoggerId = context.logger.channelId;
  }

  public setLogger(logger: any): void {
    this.lastLoggerId = logger.channelId;
  }

  public setAgentType(agentType?: AgentType | null): void {
    this.agentType = agentType ?? undefined;
  }

  public getAgentType(): AgentType | undefined {
    return this.agentType;
  }

  public getStreamingConfig(): boolean {
    return false;
  }

  public setOutputStreaming(): void {}

  public isOutputStreamingEnabled(): boolean {
    return false;
  }

  public async getClient(): Promise<unknown> {
    return {};
  }

  public async createResponse(): Promise<any> {
    return {};
  }

  public async initializeMessages(): Promise<ProviderMessage[]> {
    return [];
  }

  public async createRoundMessages(): Promise<ProviderMessage[]> {
    return [];
  }

  public createMediaContent(): any[] {
    return [];
  }

  public extractResponse(): [string, unknown, ProviderStopReason] {
    return ['', {}, MCP_STOP.END_TURN];
  }

  public addContinueMessageWithPrefill(): void {}

  public addContinueMessageWithoutPrefill(): void {}

  public async initializeOutputAndPrefill(): Promise<[boolean, ProviderMessage[]]> {
    return [false, []];
  }

  public computePrice(): number {
    return 0;
  }

  public computeResponseUsage(): any {
    return {};
  }

  public updateMessageContentWithPrefill(): void {}

  public updateMessageContentWithoutPrefill(): void {}

  public shouldContinue(): boolean {
    return false;
  }

  public checkStopConditions(): [boolean, boolean] {
    return [false, false];
  }

  public processThinkingBlock(): string | null {
    return null;
  }

  public extractToolUse(): string | null {
    return null;
  }

  public async createToolUseFollowUpMessages(): Promise<ProviderMessage[]> {
    return [];
  }

  public async createUserFollowUpMessages(): Promise<ProviderMessage[]> {
    return [];
  }

  public createAssistantMessage(): ProviderMessage {
    return {} as ProviderMessage;
  }

  public async createToolResultMessages(): Promise<ProviderMessage[]> {
    return [];
  }

  public async finalizeResponse(): Promise<unknown> {
    return {};
  }

  public createProgressiveResponse(): { append: () => void; finalize: () => void } {
    return { append: () => {}, finalize: () => {} };
  }

  public isEndTurnStop(reason: ProviderStopReason): boolean {
    return reason === MCP_STOP.END_TURN;
  }
}

class TestAgent extends BaseAgent {
  public async run(): Promise<void> {}
}

const agentConfig: AgentConfig = {
  model: 'test-model',
  agent: 'test-agent',
  instruction: '',
  useMultipleOutputs: false,
  session: { agentType: AgentType.Direct, agentCategory: AgentCategory.Workflow },
  inputFile: 'input.tex',
  inputFiles: null,
  referenceFile: null,
  referenceFiles: null,
  auxiliaryFile: null,
  auxiliaryFiles: null,
  mediaFile: null,
  mediaFiles: null,
  outputFiles: null,
  editedFile: null,
  toolConfig: DEFAULT_TOOL_CONFIG,
};

const agentSetting: AgentSetting = {
  agentType: AgentType.Direct,
  agentCategory: AgentCategory.Workflow,
  documentTag: 'document',
  endTag: '</document>',
  temperature: 0,
  requiredFiles: {},
  requiredFilesInternal: {},
  defaultOutputFiles: [],
  filePatternsContain: [],
  tools: [],
  isRewrite: true,
  rounds: 1,
  prefills: [],
  outputExt: 'tex',
  isMultipleOutput: false,
};

const agentPrompt: AgentPrompt = {
  systemPrompt: '',
  userPrefix: '',
  userRequest: '',
};

function buildContext(streamId: StreamTabId, executionId?: ExecutionId): AgentRunContext {
  return createAgentRunContext({
    streamTabId: streamId,
    executionId,
    session: { agentType: AgentType.Direct, agentCategory: AgentCategory.Workflow },
    agentName: agentConfig.agent,
    model: agentConfig.model,
    inputFile: agentConfig.inputFile,
  });
}

describe('AgentRunContext', () => {
  it('applies shared logger and identifiers to agent components', () => {
    const modelHandler = new StubModelHandler();
    const agent = new TestAgent(
      modelHandler,
      agentConfig,
      agentSetting,
      agentPrompt,
      '/tmp',
    );

    const context = buildContext('stream-ctx' as StreamTabId, 'exec-ctx' as ExecutionId);
    agent.applyRunContext(context);

    assert.strictEqual(agent.getStreamTabId(), context.streamTabId);
    assert.strictEqual(agent.getExecutionId(), context.executionId);
    assert.strictEqual(modelHandler.appliedContext, context);
    assert.strictEqual(modelHandler.lastLoggerId, context.logger.channelId);

    const usageMonitor = (agent as any).usageMonitor;
    assert.strictEqual(usageMonitor.context.streamTabId, context.streamTabId);
    assert.strictEqual(agent['logger'].channelId, context.logger.channelId);
  });
});
