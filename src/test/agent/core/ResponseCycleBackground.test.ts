// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent core
import { parseAgentConfig, type AgentConfig } from '@agent/core/AgentConfig';
import { ConversationRoundState, AgentRunState } from '@agent/core/AgentState';
import {
  AgentSetting,
  AgentPrompt,
  AgentType,
  AgentCategory,
} from '@agent/core/AgentDataclass';
import {
  createResponseCycleFlow,
  type ResponseCycleShared,
  type ResponseCycleState,
} from '@agent/core/flows/ResponseCycleFlow';
import { createRetryState } from '@agent/core/flows/RetryState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { AgentExecutionContext } from '@agent/runtime/AgentExecutionContext';
// Type imports
import type { StreamTabId } from '@agent/types/IdentifierTypes';
// Local imports - model handlers
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';
// Type imports
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
// Internal imports
import { OPENAI_CHAT_FINISH } from '@agent/modelHandlers/types/StopReasonTypes';
import * as repetitionUtils from '@agent/utils/text/repetitionUtils';
import * as debugSaver from '@agent/utils/debugMessageSaver';
// Type imports
import type { OpenAIAPIResponseUsage } from '@agent/core/ResponseUsage';
import type { AgentLogger } from '@logger/AgentLogger';
// Internal imports
import { MESSAGE_TYPES, type MessageType } from '@logger/messageTypes';
import {
  ModelConfig,
  ModelProvider,
  DEFAULT_MODEL_CAPABILITIES,
} from '@model/ModelConfig';
import replacementEngine from '@replacement/engine';
import {
  TaskRunFileService,
  WorkspaceFS,
  createWorkspaceLocation,
} from '@utils/files';
import xmlUtils from '@utils/text/xmlUtils';
import * as latex from '@latex';

// Third-party types
import type OpenAI from 'openai';
import type {
  Response,
  ResponseUsage,
} from 'openai/resources/responses/responses';

type LoggedEvent = {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  messageType?: MessageType;
};

type ConfigGetter = (
  section: string | undefined,
  key: string | undefined,
) => unknown;

class StubOpenAIResponsesHandler extends ModelHandlerOpenAIResponse {
  constructor(config: ModelConfig) {
    super(config);
  }

  override async getClient(): Promise<OpenAI> {
    return {} as OpenAI;
  }

  override async createResponse(): Promise<Response> {
    return {
      id: 'resp-1',
      status: 'completed',
      output_text: '<doc>Final</doc>',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: '<doc>Final</doc>',
              annotations: [],
            },
          ],
        },
        {
          type: 'reasoning',
          summary: [
            { type: 'text', text: 'first step' },
            { type: 'text', text: 'second step' },
          ],
        },
      ],
      usage: {
        input_tokens: 5,
        output_tokens: 7,
        total_tokens: 12,
      },
    } as unknown as Response;
  }

  override extractResponse() {
    return {
      response: '<doc>Final</doc>',
      usage: {
        input_tokens: 5,
        output_tokens: 7,
        total_tokens: 12,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
      stopReason: OPENAI_CHAT_FINISH.STOP,
    };
  }

  override updateMessageContentWithoutPrefill(): void {}

  override updateMessageContentWithPrefill(): void {}

  override addContinueMessageWithoutPrefill(): void {}

  override addContinueMessageWithPrefill(): void {}

  override shouldContinue(): boolean {
    return false;
  }

  override checkStopConditions() {
    return { endTurn: true, shouldStop: true };
  }
}

describe('ResponseCycle background reasoning logs', () => {
  const configValues = new Map<string, unknown>();
  const originalGetConfiguration = vscode.workspace.getConfiguration;
  const originalCreateOutputChannel = vscode.window.createOutputChannel;
  const originalExists = WorkspaceFS.exists;
  const originalWrite = WorkspaceFS.write;
  const originalAppend = WorkspaceFS.appendFile;
  const originalApplyAll = replacementEngine.applyAll;
  const originalBestConnection = latex.bestConnectionMethod;
  const originalRepetitionCheck = repetitionUtils.checkForMassiveRepetition;
  const originalMaybeSave = debugSaver.maybeSaveDebugObject;
  const originalFormatContent = xmlUtils.formatContent;

  const makeConfigGetter = (): ConfigGetter => {
    return (section, key) => {
      if (section && key) {
        const combined = `${section}.${key}`;
        if (configValues.has(combined)) {
          return configValues.get(combined);
        }
      }
      if (key && configValues.has(key)) {
        return configValues.get(key);
      }
      if (key) {
        const prefixedKey = `texra.${key}`;
        if (configValues.has(prefixedKey)) {
          return configValues.get(prefixedKey);
        }
      }
      if (section && configValues.has(section)) {
        return configValues.get(section);
      }
      if (section) {
        const prefixedSection = `texra.${section}`;
        if (configValues.has(prefixedSection)) {
          return configValues.get(prefixedSection);
        }
      }
      return undefined;
    };
  };

  before(() => {
    (vscode.workspace as any).getConfiguration = (section?: string) => ({
      get: (key?: string) => makeConfigGetter()(section, key),
      update: () => Promise.resolve(),
      inspect: () => undefined,
    });
    (vscode.window as any).createOutputChannel = () => ({
      appendLine: () => {},
      dispose: () => {},
      show: () => {},
      hide: () => {},
      clear: () => {},
    });
  });

  after(() => {
    (vscode.workspace as any).getConfiguration = originalGetConfiguration;
    (vscode.window as any).createOutputChannel = originalCreateOutputChannel;
  });

  beforeEach(() => {
    configValues.clear();
    configValues.set('model.useStreaming', true);
    configValues.set('model.useStreamingOpenai', true);
    configValues.set('model.useBackgroundResponses', true);
    configValues.set('texra.model.useStreaming', true);
    configValues.set('texra.model.useStreamingOpenai', true);
    configValues.set('texra.model.useBackgroundResponses', true);

    WorkspaceFS.exists = async () => false;
    WorkspaceFS.write = async () => {};
    WorkspaceFS.appendFile = async () => {};

    (replacementEngine as any).applyAll = (text: string) => text;
    (latex as any).bestConnectionMethod = async () => ({ connector: '' });
    (repetitionUtils as any).checkForMassiveRepetition = () => ({
      massiveRepetitionDetected: false,
      ratio: 0,
      longestMatch: '',
    });
    (debugSaver as any).maybeSaveDebugObject = async () => {};
    (xmlUtils as any).formatContent = async (content: string) => content.trim();
  });

  afterEach(() => {
    WorkspaceFS.exists = originalExists;
    WorkspaceFS.write = originalWrite;
    WorkspaceFS.appendFile = originalAppend;
    (replacementEngine as any).applyAll = originalApplyAll;
    (latex as any).bestConnectionMethod = originalBestConnection;
    (repetitionUtils as any).checkForMassiveRepetition =
      originalRepetitionCheck;
    (debugSaver as any).maybeSaveDebugObject = originalMaybeSave;
    (xmlUtils as any).formatContent = originalFormatContent;
  });

  it('logs reasoning content when background responses disable streaming', async () => {
    const loggedEvents: LoggedEvent[] = [];
    const loggerStub = {
      channelId: 'test',
      isAgentLogger: true,
      debug(message: string, _groupId?: string, messageType?: MessageType) {
        loggedEvents.push({ level: 'debug', message, messageType });
      },
      info(message: string, _groupId?: string, messageType?: MessageType) {
        loggedEvents.push({ level: 'info', message, messageType });
      },
      warn() {},
      error() {},
      fileList() {},
      missingOutputs() {},
      latexDiff() {},
      statistics() {},
      userMessage() {},
      startGroup: async () => 'group',
      endGroup() {},
      withCurrentGroup: () => undefined,
      runWithinCurrentGroup: async (fn: () => any) => fn(),
      runWithGroup: async (_groupId: string | undefined, fn: () => any) => fn(),
    } as unknown as AgentLogger;

    const handlerConfig: ModelConfig = {
      name: 'openai-response-test',
      fullName: 'openai-response-test',
      provider: ModelProvider.OPENAI,
      maxOutputTokens: 4096,
      inputPrice: 0,
      outputPrice: 0,
      contextWindow: 8192,
      capabilities: {
        ...DEFAULT_MODEL_CAPABILITIES,
        supportsReasoning: true,
      },
      openRouterOnly: false,
    };

    const handler = new StubOpenAIResponsesHandler(handlerConfig);
    handler.setLogger(loggerStub);

    assert.equal(handler.getStreamingConfig(), false);

    const agentSetting: AgentSetting = {
      agentType: AgentType.CoT,
      agentCategory: AgentCategory.Workflow,
      documentTag: 'doc',
      endTag: '</doc>',
      temperature: 0,
      requiredFiles: {},
      requiredFilesInternal: {},
      defaultOutputFiles: [],
      filePatternsContain: [],
      tools: [],
      isRewrite: true,
      rounds: 1,
      prefills: [],
      outputExt: 'txt',
      isMultipleOutput: false,
    };

    const agentPrompt: AgentPrompt = {
      systemPrompt: '',
      userPrefix: '',
      userRequest: 'Explain the process',
    };

    const agentConfig: AgentConfig = parseAgentConfig({
      model: handlerConfig.name,
      agent: 'test-agent',
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

    const messages: ProviderMessage[] = [];
    const round = new ConversationRoundState(1);
    const run = new AgentRunState();
    const workspace = AgentWorkspaceState.create();
    const userVars = {} as Record<string, any>;
    const outputLocation = createWorkspaceLocation(
      WorkspaceFS.fullPath('output.txt'),
      'output.txt',
    );

    // Create shared state for the cycle flow
    const shared: ResponseCycleShared = {
      state: {
        messages,
        outputLocation,
        endTurn: false,
        shouldStop: false,
        outputExists: false,
        systemPrompt: undefined,
        debug: undefined,
        responseObject: undefined,
        responseTimeMs: undefined,
        stopReason: undefined,
        processedResponse: undefined,
      } satisfies ResponseCycleState,
      retryState: createRetryState(),
    };

    // Create and run the flow directly
    const flow = createResponseCycleFlow();
    flow.setServices({
      modelHandler: handler,
      agentSetting,
      agentConfig,
      agentPrompt,
      userVars,
      logger: loggerStub,
      client: {} as OpenAI,
      checkInterruption: () => false,
      setAbortController: () => {},
      context: new AgentExecutionContext({
        streamId: 'test-stream' as StreamTabId,
      }),
      fileService: new TaskRunFileService(),
      round,
      run,
      workspace,
    });
    await flow.run(shared);

    const thinkingLogs = loggedEvents.filter(
      (event) =>
        event.level === 'info' && event.messageType === MESSAGE_TYPES.THINKING,
    );
    assert.equal(
      thinkingLogs.length,
      1,
      'Expected reasoning log when streaming is disabled by background mode',
    );
    assert.equal(thinkingLogs[0]?.message, 'first step\nsecond step');
  });

  it('allows streaming when background responses are disabled', async () => {
    configValues.clear();
    configValues.set('model.useStreaming', true);
    configValues.set('model.useStreamingOpenai', true);
    configValues.set('model.useBackgroundResponses', false);
    configValues.set('texra.model.useStreaming', true);
    configValues.set('texra.model.useStreamingOpenai', true);
    configValues.set('texra.model.useBackgroundResponses', false);

    const loggerStub = {
      channelId: 'test',
      isAgentLogger: true,
      debug() {},
      info() {},
      warn() {},
      error() {},
      fileList() {},
      missingOutputs() {},
      latexDiff() {},
      statistics() {},
      userMessage() {},
      startGroup: async () => 'group',
      endGroup() {},
      withCurrentGroup: () => undefined,
      runWithinCurrentGroup: async (fn: () => any) => fn(),
      runWithGroup: async (_groupId: string | undefined, fn: () => any) => fn(),
    } as unknown as AgentLogger;

    const handlerConfig: ModelConfig = {
      name: 'openai-response-test',
      fullName: 'openai-response-test',
      provider: ModelProvider.OPENAI,
      maxOutputTokens: 4096,
      inputPrice: 0,
      outputPrice: 0,
      contextWindow: 8192,
      capabilities: {
        ...DEFAULT_MODEL_CAPABILITIES,
        supportsReasoning: true,
      },
      openRouterOnly: false,
    };

    const handler = new StubOpenAIResponsesHandler(handlerConfig);
    handler.setLogger(loggerStub);

    assert.equal(
      handler.getStreamingConfig(),
      true,
      'Expected streaming to be enabled when background mode is disabled',
    );
  });
});
