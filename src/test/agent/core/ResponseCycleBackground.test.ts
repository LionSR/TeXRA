// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent core
import { parseAgentConfig, type AgentConfig } from '@agent/core/AgentConfig';
import { RoundMetricsState, RunMetricsState } from '@agent/core/AgentState';
import {
  AgentSetting,
  AgentPrompt,
  AgentType,
  AgentCategory,
} from '@agent/core/AgentDataclass';
import { runResponseCycle } from '@agent/core/ResponseCycle';
import { ToolState } from '@agent/core/ToolState';

// Local imports - model handlers
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/modelHandlerOpenAIResponse';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import { OPENAI_CHAT_FINISH } from '@agent/modelHandlers/types/StopReasonTypes';

// Local imports - logging
import type { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES, type MessageType } from '@logger/messageTypes';

// Local imports - model configuration
import {
  ModelConfig,
  ModelProvider,
  DEFAULT_MODEL_CAPABILITIES,
} from '@model/ModelConfig';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';
import * as latex from '@latex';
import replacementEngine from '@replacement/engine';
import * as repetitionUtils from '@agent/utils/text/repetitionUtils';
import * as debugSaver from '@agent/utils/debugMessageSaver';
import xmlUtils from '@utils/text/xmlUtils';
import type { OpenAIAPIResponseUsage } from '@agent/core/ResponseUsage';

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

  override extractResponse(): [string, any, string] {
    return [
      '<doc>Final</doc>',
      { totalInputTokens: 5, totalOutputTokens: 7 },
      OPENAI_CHAT_FINISH.STOP,
    ];
  }

  override computeResponseUsage(
    _responseUsage: ResponseUsage | undefined,
    responseTime: number,
  ): OpenAIAPIResponseUsage {
    return {
      totalInputTokens: 5,
      totalOutputTokens: 7,
      percentageCached: 0,
      cost: 0,
      responseTime,
      prompt_tokens: 5,
      completion_tokens: 7,
      cached_tokens: 0,
      reasoning_tokens: 0,
      accepted_prediction_tokens: null,
      rejected_prediction_tokens: null,
    };
  }

  override updateMessageContentWithoutPrefill(): void {}

  override updateMessageContentWithPrefill(): void {}

  override addContinueMessageWithoutPrefill(): void {}

  override addContinueMessageWithPrefill(): void {}

  override shouldContinue(): boolean {
    return false;
  }

  override checkStopConditions(): [boolean, boolean] {
    return [true, true];
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
      getActiveGroupId: () => undefined,
      setActiveGroupId() {},
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
    const stateRound = new RoundMetricsState(1);
    const stateGlobal = new RunMetricsState();
    const toolState = new ToolState();

    await runResponseCycle({
      options: {
        modelHandler: handler,
        agentSetting,
        agentConfig,
        agentPrompt,
        userVars: {},
        logger: loggerStub,
        client: {} as OpenAI,
        checkInterruption: () => false,
        setAbortController: () => {},
      },
      messages,
      stateRound,
      stateGlobal,
      toolState,
      outputFile: 'output.txt',
    });

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
      getActiveGroupId: () => undefined,
      setActiveGroupId() {},
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
