// Standard library imports
import { randomUUID } from 'crypto';

// Third-party imports
import { FinishReason } from '@google/genai';
import { encode as encodeHtml } from 'he';

// Local imports - agent components
import type { AgentConfig } from '../core/AgentConfig';
import { AgentSetting, AgentType, hasEndTag } from '../core/AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from '../core/AgentState';
import { ToolState } from '../core/ToolState';
import type { IModelHandler } from './types/IModelHandler';
import type { ProviderMessage } from './types/ProviderMessage';
import type { ProviderStopReason } from './types/StopReasonTypes';
import {
  ANTHROPIC_STOP,
  OPENAI_CHAT_FINISH,
  MCP_STOP,
} from './types/StopReasonTypes';
import { MediaEntry } from '@agent/utils/mediaTypes';
import { MediaAttachmentProcessor } from './support/MediaAttachmentProcessor';
import { SecretManager, ApiProvider } from '@frontend/secretManager';

// Local imports - events
import { bus } from '@eventBus/ProgressEventBus';

// Local imports - log
import { AgentLogger } from '@logger/AgentLogger';
import { MESSAGE_TYPES, MessageType } from '@logger/messageTypes';
import type { ToolDefinition } from '@model';
import {
  ModelConfig,
  ModelProvider,
  ModelCapabilities,
} from '@model/ModelConfig';
import { getConfig } from '@utils/config';

// Local imports - utilities
import { normalizeUrl } from '@utils/urlUtils';

// Default continuation limits
const DEFAULT_CONTINUE_LIMIT = 10;

// Default token limits
const DEFAULT_INPUT_TOKEN_LIMIT = 1500000;
const DEFAULT_OUTPUT_TOKEN_LIMIT_FACTOR = 2.5;

// Default proxy domain
const DEFAULT_PROXY_DOMAIN = 'proxy.texra.ai';

function cloneCapabilities(capabilities: ModelCapabilities): ModelCapabilities {
  const globalStructuredClone = (
    globalThis as {
      structuredClone?: <T>(value: T) => T;
    }
  ).structuredClone;

  if (typeof globalStructuredClone === 'function') {
    return globalStructuredClone(capabilities);
  }

  return JSON.parse(JSON.stringify(capabilities)) as ModelCapabilities;
}

/** Flags for token-based stop conditions. */
interface TokenFlags {
  continuationLimit: boolean;
  inputTokenLimit: boolean;
  maxOutputTokensExceeded: boolean;
}

/** Flags for markers indicating the end of a conversation. */
interface MarkerFlags {
  endTurn: boolean;
  encounterDocumentTag: boolean;
}

/**
 * Abstract base class for model-specific handlers that manage API interactions, message processing, and response handling.
 */
export abstract class ModelHandler<
  M extends ProviderMessage = ProviderMessage,
  U = any,
  R = any,
  T = unknown,
  C = unknown,
> implements IModelHandler<M, U, R, T, C>
{
  public config: ModelConfig;
  public capabilities: ModelCapabilities;
  public continueLimit: number;
  public inputTokenLimit: number;
  public maxOutputTokensFactor: number;
  protected logger: AgentLogger;
  protected outputStreaming = false;
  protected backgroundModeSupported = false;
  protected progressViewEnabled = true;
  protected agentType?: AgentType;
  protected mediaProcessor: MediaAttachmentProcessor;

  protected get supportsToolFileOutputs(): boolean {
    return false;
  }

  protected get supportsInlineToolImages(): boolean {
    return false;
  }

  constructor(config: ModelConfig) {
    this.config = { ...config };
    this.capabilities = cloneCapabilities(config.capabilities);
    this.continueLimit = DEFAULT_CONTINUE_LIMIT;
    this.inputTokenLimit = DEFAULT_INPUT_TOKEN_LIMIT;
    this.maxOutputTokensFactor = DEFAULT_OUTPUT_TOKEN_LIMIT_FACTOR;
    // Initialize with default channel, will be overwritten by agent
    this.logger = new AgentLogger('Agent');
    this.mediaProcessor = new MediaAttachmentProcessor(this.logger, {
      getCapabilities: () => this.capabilities,
      isOpenAIProvider: () => this.isOpenai,
    });
  }

  /**
   * Updates the logger instance.
   */
  public setLogger(logger: AgentLogger): void {
    this.logger = logger;
    this.mediaProcessor.setLogger(logger);
  }

  /**
   * Records the active agent type so provider handlers can adjust behaviour per session.
   */
  public setAgentType(agentType?: AgentType | null): void {
    this.agentType = agentType ?? undefined;
  }

  /**
   * Returns the agent type that is currently driving the handler, if any.
   */
  public getAgentType(): AgentType | undefined {
    return this.agentType;
  }

  /**
   * Enables or disables streaming of model output text.
   */
  public setOutputStreaming(enabled: boolean): void {
    this.outputStreaming = enabled;
  }

  /**
   * Indicates whether model output streaming is enabled.
   */
  public isOutputStreamingEnabled(): boolean {
    return this.outputStreaming;
  }

  /**
   * Enables or disables Progress view updates.
   */
  public setProgressViewEnabled(enabled: boolean): void {
    this.progressViewEnabled = enabled;
  }

  /**
   * Creates a log stream for progressive updates to the Progress view.
   *
   * @param type Message type for the stream.
   * @param groupId Optional log group identifier.
   * @returns Object with `append` and `finalize` helpers.
   */
  protected createLogStream(type: MessageType, groupId?: string) {
    const streamId = this.logger.channelId;
    const id = randomUUID();
    let buffer = '';
    let isFirstUpdate = true;

    return {
      append: (text: string) => {
        if (!text) return;
        buffer += text;

        if (!this.progressViewEnabled) {
          return;
        }

        // Use addLogMessage for the first update, updateLogMessage for subsequent ones
        if (isFirstUpdate) {
          bus.emit('addLogMessage', {
            stream: streamId,
            logMessage: {
              id,
              text: encodeHtml(buffer),
              level: 'info',
              timestamp: Date.now(),
              groupId,
              messageType: type,
            },
          });
          isFirstUpdate = false;
        } else {
          bus.emit('updateLogMessage', {
            stream: streamId,
            logMessage: {
              id,
              text: encodeHtml(buffer),
              groupId,
              messageType: type,
            },
          });
        }
      },
      finalize: (finalText?: string) => {
        if (typeof finalText === 'string') {
          buffer = finalText;
        }

        if (!this.progressViewEnabled) {
          this.logger.debug(`Final ${type} length: ${buffer.length}`, groupId);
          return buffer;
        }

        // If we never appended anything, create the initial entry
        if (isFirstUpdate) {
          bus.emit('addLogMessage', {
            stream: streamId,
            logMessage: {
              id,
              text: encodeHtml(buffer),
              level: 'info',
              timestamp: Date.now(),
              groupId,
              messageType: type,
            },
          });
        } else {
          bus.emit('updateLogMessage', {
            stream: streamId,
            logMessage: {
              id,
              text: encodeHtml(buffer),
              groupId,
              messageType: type,
            },
          });
        }

        this.logger.debug(`Final ${type} length: ${buffer.length}`, groupId);
        return buffer;
      },
    };
  }

  /**
   * Convenience wrapper for thinking streams.
   */
  protected createThinkingStream(groupId?: string) {
    return this.createLogStream(MESSAGE_TYPES.THINKING, groupId);
  }

  /**
   * Convenience wrapper for output streams.
   */
  protected createOutputStream(groupId?: string) {
    return this.createLogStream(MESSAGE_TYPES.MODEL_RESPONSE, groupId);
  }

  /**
   * Retrieves API key from environment variables based on provider and OpenRouter configuration.
   * @throws Error if required API key is missing from environment
   */
  public async getApiKey(): Promise<string> {
    // Use OpenRouter if model requires it or if explicitly configured
    const useOpenRouter =
      this.config.openRouterOnly ||
      getConfig<boolean>('texra.model.useOpenRouter', false);

    if (useOpenRouter) {
      try {
        return await SecretManager.getApiKey('openRouter');
      } catch (err) {
        throw new Error(
          'Missing API key for OpenRouter. Please set it using the "Set API Key" command.',
        );
      }
    }

    const provider = this.config.provider.toLowerCase() as ApiProvider;
    try {
      return await SecretManager.getApiKey(provider);
    } catch (err) {
      throw new Error(
        `Missing API key for ${this.config.provider}. Please set it using the "Set API Key" command.`,
      );
    }
  }

  /**
   * Retrieves base URL for API requests based on provider and OpenRouter configuration.
   * @returns Base URL string or null for providers using default URLs
   */
  public getBaseUrl(): string | null {
    // Use OpenRouter if model requires it or if explicitly configured
    const useOpenRouter =
      this.config.openRouterOnly ||
      getConfig<boolean>('texra.model.useOpenRouter', false);
    const useImprovedConnection = getConfig<boolean>(
      'texra.model.useImprovedConnection',
      false,
    );
    const configValue = getConfig<string>(
      'texra.model.improvedConnectionDomain',
      DEFAULT_PROXY_DOMAIN,
    );
    let improvedConnectionDomain = (configValue || '').trim();

    if (!improvedConnectionDomain) {
      this.logger.debug(`Using default proxy domain: ${DEFAULT_PROXY_DOMAIN}`);
      improvedConnectionDomain = DEFAULT_PROXY_DOMAIN;
    }

    if (useImprovedConnection) {
      // Normalize proxy domain
      improvedConnectionDomain = normalizeUrl(improvedConnectionDomain);

      // Define supported proxy paths for specific providers
      // Only these providers are supported by the proxy
      const PROXY_PATHS: Partial<Record<ModelProvider, string>> = {
        // [ModelProvider.GOOGLE]: 'generativelanguage/v1beta',
        [ModelProvider.GOOGLE]: 'generativelanguage',
        [ModelProvider.OPENAI]: 'openai/v1',
        // [ModelProvider.ANTHROPIC]: 'anthropic/v1',
        [ModelProvider.ANTHROPIC]: 'anthropic',
        [ModelProvider.XAI]: 'xai',
        // [ModelProvider.OPENROUTER]: 'openrouter',
        // Additional providers that may be accessed via OpenRouter
        // groq: 'groq/openai/v1',
        // perplexity: 'pplx',
        // mistral: 'mistral',
        // cerebras: 'cerebras',
      };

      // Check if using OpenRouter
      if (useOpenRouter) {
        this.logger.debug(
          `Using proxy for ${this.config.provider} for OpenRouter`,
        );
        return `https://${improvedConnectionDomain}/openrouter`;
      }

      // Check if provider is supported by proxy
      const path = PROXY_PATHS[this.config.provider];
      if (path) {
        this.logger.debug(
          `Using proxy for ${this.config.provider}: with ${improvedConnectionDomain}/${path}`,
        );
        return `https://${improvedConnectionDomain}/${path}`;
      }

      // Provider not supported by proxy, fall through to regular URLs
    }

    if (useOpenRouter) {
      return 'https://openrouter.ai/api/v1';
    }

    const customDeepSeekUrl = getConfig<string>(
      'texra.model.baseUrlDeepSeek',
      '',
    );
    if (customDeepSeekUrl && this.config.provider === ModelProvider.DEEPSEEK) {
      const normalized = normalizeUrl(customDeepSeekUrl);
      return `https://${normalized}`;
    }

    // Provider-specific base URLs
    const BASE_URLS: Record<ModelProvider, string | null> = {
      // [ModelProvider.GOOGLE]:
      //   // 'https://generativelanguage.googleapis.com/v1beta/openai/',
      //   'https://generativelanguage.googleapis.com/v1beta/',
      [ModelProvider.GOOGLE]: null,
      [ModelProvider.OPENAI]: null, // OpenAI uses default base URL
      // [ModelProvider.ANTHROPIC]: 'https://api.anthropic.com/v1/',
      [ModelProvider.ANTHROPIC]: null,
      [ModelProvider.DEEPSEEK]: 'https://api.deepseek.com',
      [ModelProvider.XAI]: 'https://api.x.ai/v1',
      [ModelProvider.MOONSHOT]: 'https://api.moonshot.cn/v1',
      [ModelProvider.DASHSCOPE]:
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      [ModelProvider.COPILOT]: null,
      [ModelProvider.OTHERS]: null,
    };
    return BASE_URLS[this.config.provider];
  }

  /** Checks if the model uses an OpenAI-compatible API format. */
  get isOpenaiCompatible(): boolean {
    return [
      ModelProvider.OPENAI,
      ModelProvider.GOOGLE,
      ModelProvider.OTHERS,
      ModelProvider.DEEPSEEK,
      ModelProvider.XAI,
      ModelProvider.MOONSHOT,
      ModelProvider.DASHSCOPE,
      ModelProvider.ANTHROPIC,
    ].includes(this.config.provider);
  }

  /** Checks if the model is from Anthropic provider. */
  get isAnthropic(): boolean {
    return this.config.provider === ModelProvider.ANTHROPIC;
  }

  /** Checks if the model is from OpenAI provider. */
  get isOpenai(): boolean {
    return this.config.provider === ModelProvider.OPENAI;
  }

  /** Checks if the model is from Google provider. */
  get isGoogle(): boolean {
    return this.config.provider === ModelProvider.GOOGLE;
  }

  /**
   * Gets streaming configuration for the current model provider
   * @returns Boolean indicating if streaming should be enabled
   */
  public getStreamingConfig(): boolean {
    const useStreamingGlobal = getConfig<boolean>(
      'texra.model.useStreaming',
      false,
    );

    // For OpenRouter models, use dedicated setting
    if (
      this.config.openRouterOnly ||
      getConfig<boolean>('texra.model.useOpenRouter', false)
    ) {
      return getConfig<boolean>(
        'texra.model.useStreamingOpenrouter',
        useStreamingGlobal,
      );
    }

    // Map ModelProvider enum to configuration key suffix
    const providerConfigMap: Record<ModelProvider, string> = {
      [ModelProvider.ANTHROPIC]: 'Anthropic',
      [ModelProvider.OPENAI]: 'Openai',
      [ModelProvider.GOOGLE]: 'Google',
      [ModelProvider.DEEPSEEK]: 'Deepseek',
      [ModelProvider.MOONSHOT]: 'Moonshot',
      [ModelProvider.DASHSCOPE]: 'Dashscope',
      [ModelProvider.COPILOT]: 'Copilot',
      [ModelProvider.XAI]: 'Xai',
      [ModelProvider.OTHERS]: '', // Will fall back to global
    };

    const configSuffix = providerConfigMap[this.config.provider];

    // If no mapping exists or it's the OTHERS provider, just use global setting
    if (!configSuffix) {
      return useStreamingGlobal;
    }

    // Build the full config key and fetch the setting
    const configKey = `texra.model.useStreaming${configSuffix}`;
    return getConfig<boolean>(configKey, useStreamingGlobal);
  }

  get isOReasoningModel(): boolean {
    return (
      this.config.provider === ModelProvider.OPENAI &&
      this.capabilities.supportsReasoning
    );
  }

  get isGrokReasoningModel(): boolean {
    return (
      this.config.provider === ModelProvider.XAI &&
      this.capabilities.supportsReasoning
    );
  }

  /**
   * Validates reasoning effort based on provider-specific support
   * @param effort The reasoning effort level to validate
   * @returns Valid reasoning effort string for the current provider
   */
  protected validateReasoningEffort(effort: string): string {
    // Default implementation - return as is for most providers
    if (this.config.provider === ModelProvider.XAI) {
      // xAI models only support 'low' and 'high'
      if (effort === 'low' || effort === 'high') {
        return effort;
      }

      // Default to 'high' for other values
      this.logger.warn(
        `xAI models only support 'low' or 'high' reasoning effort. Converting '${effort}' to 'high'.`,
      );
      return 'high';
    }

    // For other providers, return effort as is
    return effort;
  }

  /**
   * Create image/audio messages for the conversation.
   * This is a shared implementation that can be used by all providers.
   * Individual providers can override if needed.
   */
  public async createMediaMessage(mediaFiles: string[]): Promise<any[]> {
    const { entries, results } =
      await this.mediaProcessor.loadEntries(mediaFiles);
    this.mediaProcessor.logResults(results);
    return this.createMediaContent(entries);
  }

  /** Calculates token-based stop flags. */
  protected computeTokenFlags(
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
  ): TokenFlags {
    const maxOutputTokens =
      stateGlobal.firstInputTokens > 0
        ? this.maxOutputTokensFactor * stateGlobal.firstInputTokens
        : Number.POSITIVE_INFINITY;

    return {
      continuationLimit: stateRound.continuationCount > this.continueLimit,
      inputTokenLimit: stateGlobal.totalInputTokens > this.inputTokenLimit,
      maxOutputTokensExceeded: stateGlobal.totalOutputTokens > maxOutputTokens,
    };
  }

  /** Detects stop markers in model output. */
  protected detectStopMarkers(
    stopReason: ProviderStopReason,
    response: string,
    setting: AgentSetting,
  ): MarkerFlags {
    const endTurnReasons: ProviderStopReason[] = [
      ANTHROPIC_STOP.END_TURN,
      ANTHROPIC_STOP.STOP_SEQUENCE,
      OPENAI_CHAT_FINISH.STOP,
      FinishReason.STOP,
      'STOP', // handle string form returned by some Google clients
    ];

    return {
      endTurn: endTurnReasons.includes(stopReason ?? ''),
      encounterDocumentTag: response.includes(`</${setting.documentTag}>`),
    };
  }

  /**
   * Evaluates conversation stop conditions based on model response and state.
   * @returns Tuple of [endTurn: should end current turn, shouldStop: should stop conversation]
   */
  public checkStopConditions(
    stopReason: ProviderStopReason,
    newResponse: string,
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    agentSetting: AgentSetting,
  ): [boolean, boolean] {
    const tokenFlags = this.computeTokenFlags(stateRound, stateGlobal);
    const markerFlags = this.detectStopMarkers(
      stopReason,
      newResponse,
      agentSetting,
    );

    if (tokenFlags.maxOutputTokensExceeded) {
      this.logger.warn(
        `Output tokens exceed ${this.maxOutputTokensFactor}x input tokens`,
      );
      this.logger.warn(
        `Total output tokens: ${stateGlobal.totalOutputTokens}, First input tokens: ${stateGlobal.firstInputTokens}`,
      );
    }

    const shouldStop =
      markerFlags.encounterDocumentTag ||
      tokenFlags.continuationLimit ||
      tokenFlags.inputTokenLimit;

    if (shouldStop) {
      this.logger.debug(
        `StopFlags: endTurn: ${markerFlags.endTurn} encounterDocumentTag: ${markerFlags.encounterDocumentTag} continuation_limit: ${tokenFlags.continuationLimit} inputTokenLimit: ${tokenFlags.inputTokenLimit} maxOutputTokens: ${tokenFlags.maxOutputTokensExceeded}`,
      );
    }

    return [markerFlags.endTurn, shouldStop];
  }

  public containCutOffMessage(content: any[] | string): boolean {
    if (typeof content === 'string') {
      return content.includes('Your response got cut off');
    }
    return content.some((c: { type: string; text: string }) =>
      c.text?.includes('Your response got cut off'),
    );
  }

  /** Creates and configures a client instance for the specific model provider. */
  abstract getClient(): Promise<C>;

  /**
   * Generates a model response using the provider's API.
   * @returns Promise resolving to provider-specific response object
   */
  abstract createResponse(
    client: C,
    messages: M[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): Promise<any>;

  /**
   * Creates initial message array for conversation with optional images and system prompt.
   * @returns Promise resolving to provider-specific message array
   */
  abstract initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: string[],
    systemPrompt?: string,
  ): Promise<M[]>;

  /**
   * Creates messages for follow-up conversation rounds with optional images.
   * @returns Provider-specific message array with new round content
   */
  abstract createRoundMessages(
    messages: M[],
    userMessage: string,
    mediaFiles?: string[],
  ): Promise<M[]>;

  /**
   * Formats image content into provider-specific message format.
   * @returns Array of formatted image/document content objects
   */
  abstract createMediaContent(mediaMessage: MediaEntry[]): any[];

  /**
   * Extracts the response text and metadata from the model's response object
   * @param responseObject The raw response object from the model
   * @param endTag The end tag to append if needed
   * @returns A tuple containing [responseText, usageInfo, stopReason]
   */
  abstract extractResponse(
    responseObject: any,
    endTag: string,
  ): [string, any, ProviderStopReason];

  /**
   * Manages continuation for truncated responses in multi-turn conversations with prefill support.
   * Updates messages array and tool state for next turn.
   */
  abstract addContinueMessageWithPrefill(
    messages: M[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void;

  /**
   * Manages continuation for truncated responses in multi-turn conversations without prefill support.
   * Updates messages array and tool state for next turn.
   */
  abstract addContinueMessageWithoutPrefill(
    messages: M[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void;

  /**
   * Sets up output file and handles content prefilling.
   * @returns Promise resolving to [isComplete: generation complete, messages: updated message array]
   */
  abstract initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: M[],
    toolState: ToolState,
    outputFile: string,
    prefill: string,
  ): Promise<[boolean, M[]]>;

  /**
   * Calculates API usage cost based on token counts and provider pricing.
   * @returns Total cost in provider's currency units
   */
  abstract computePrice(responseUsage: U): number;

  /**
   * Computes detailed usage metrics from model response.
   * @returns Provider-specific response usage object
   */
  abstract computeResponseUsage(responseUsage: U, responseTime: number): R;

  /**
   * Updates model message content with response for models with prefill support.
   * Handles cache control and content formatting.
   */
  abstract updateMessageContentWithPrefill(
    messages: M[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void;

  /**
   * Updates model message content with response for models without prefill support.
   * Handles cache control and content formatting.
   */
  abstract updateMessageContentWithoutPrefill(
    messages: M[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void;

  /**
   * Determines if model should continue generating based on response state.
   * @returns Boolean indicating if generation should continue
   */
  abstract shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean;

  /**
   * Extracts thinking content from model responses
   * @param responseObject The raw response object from the model
   * @param groupId Optional group ID for logging
   * @param toolState Optional toolState to update with the thinking block
   * @returns The extracted thinking content string or null if no thinking content is available
   */
  abstract processThinkingBlock(
    responseObject: any,
    groupId?: string,
    toolState?: ToolState,
  ): string | null;

  /**
   * Extracts tool-use information from provider responses.
   * @param responseObject The raw response object from the model
   * @returns JSON string with tool call details or null if not present
   */
  extractToolUse(_responseObject: any): string | null {
    return null;
  }

  /**
   * Build a provider-specific follow-up message containing a tool result.
   */
  abstract createToolUseFollowUpMessages(
    client: C | undefined,
    id: string,
    name: string,
    call: T,
    result: Record<string, unknown>,
    toolState?: ToolState,
    text?: string,
  ): Promise<M[]>;

  /**
   * Append a simple text follow-up from the user.
   */
  abstract createUserFollowUpMessages(
    messages: M[],
    userMessage: string,
  ): Promise<M[]>;

  /** Build a simple assistant message from text. */
  abstract createAssistantMessage(text: string): M;

  /** Check if stop reason signals end-turn. */
  public isEndTurnStop(reason: ProviderStopReason): boolean {
    return (
      reason === ANTHROPIC_STOP.END_TURN ||
      reason === MCP_STOP.END_TURN ||
      String(reason).toLowerCase() === 'end_turn' ||
      String(reason).toLowerCase() === 'endturn'
    );
  }

  /**
   * Creates a log group for model operations with the given name.
   * @param name Name of the operation group
   * @param parentGroupId Optional parent group ID
   * @returns The group ID
   */
  protected async createOperationGroup(
    name: string,
    parentGroupId?: string,
  ): Promise<string> {
    return await this.logger.startGroup(
      `Model Operation: ${name}`,
      undefined,
      parentGroupId,
    );
  }

  /**
   * Ends a model operation log group with the given status.
   * @param groupId ID of the group to end
   * @param status Status of the operation ('error' or 'stopped')
   */
  protected endOperationGroup(
    groupId: string,
    status: 'error' | 'stopped' = 'stopped',
  ): void {
    this.logger.endGroup(groupId, status);
  }
}
