// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports - core
import * as logger from '../logger/logUtils';

// Local imports - agent components
import { AgentConfig } from './AgentConfig';
import { AgentSettings } from './AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from './AgentState';
import { ModelConfig, ModelProvider, ModelCapabilities } from './ModelConfig';
import { ToolState } from './ToolState';

// Default continuation limits
const DEFAULT_CONTINUE_LIMIT = 10;
const CONFIRMATION_CONTINUE_LIMIT = 20;

// Default token limits
const DEFAULT_INPUT_TOKEN_LIMIT = 1500000;
const DEFAULT_OUTPUT_TOKEN_LIMIT_FACTOR = 2.5;

/**
 * Base class for model-specific handlers.
 */
export abstract class ModelHandler {
  public config: ModelConfig;
  public capabilities: ModelCapabilities;
  public continueLimit: number;
  public inputTokenLimit: number;
  public maxOutputTokensFactor: number;

  constructor(config: ModelConfig) {
    this.config = config;
    this.capabilities = config.capabilities;
    this.continueLimit = this.capabilities.likesToAskForConfirmation
      ? CONFIRMATION_CONTINUE_LIMIT
      : DEFAULT_CONTINUE_LIMIT;
    this.inputTokenLimit = DEFAULT_INPUT_TOKEN_LIMIT;
    this.maxOutputTokensFactor = DEFAULT_OUTPUT_TOKEN_LIMIT_FACTOR;
  }

  /**
   * Get API key based on provider and OpenRouter configuration.
   */
  public getApiKey(): string {
    if (this.config.useOpenRouter) {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) {
        throw new Error('Missing OPENROUTER_API_KEY in environment');
      }
      return key;
    }

    const envKey = `${this.config.provider.toUpperCase()}_API_KEY`;
    const key = process.env[envKey];
    if (!key) {
      throw new Error(`Missing ${envKey} in environment`);
    }
    return key;
  }

  /**
   * Get base URL based on provider and OpenRouter configuration.
   */
  public getBaseUrl(): string | null {
    if (this.config.useOpenRouter) {
      return 'https://openrouter.ai/api/v1';
    }

    // Provider-specific base URLs
    const BASE_URLS: Record<ModelProvider, string | null> = {
      [ModelProvider.GOOGLE]:
        'https://generativelanguage.googleapis.com/v1beta/openai/',
      [ModelProvider.OPENAI]: null, // OpenAI uses default base URL
      [ModelProvider.ANTHROPIC]: null, // Anthropic uses default base URL
      [ModelProvider.OTHERS]: null,
    };
    return BASE_URLS[this.config.provider];
  }

  /** Check if this is using an OpenAI-compatible API. */
  get isOpenaiCompatible(): boolean {
    return [
      ModelProvider.OPENAI,
      ModelProvider.GOOGLE,
      ModelProvider.OTHERS,
    ].includes(this.config.provider);
  }

  /** Check if this is an Anthropic model. */
  get isAnthropic(): boolean {
    return this.config.provider === ModelProvider.ANTHROPIC;
  }

  /** Check if this is an OpenAI model. */
  get isOpenai(): boolean {
    return this.config.provider === ModelProvider.OPENAI;
  }

  /** Check if this is a Google model. */
  get isGoogle(): boolean {
    return this.config.provider === ModelProvider.GOOGLE;
  }

  /**
   * Check if the conversation should stop and print debug info if stopping.
   * @param stopReason The reason for stopping from the model response
   * @param newResponse The new response text
   * @param stateRound The current round state
   * @param stateGlobal The global conversation state
   * @param agentSettings The agent settings
   * @returns Tuple of [endTurn: boolean, shouldStop: boolean]
   */
  public checkStopConditions(
    stopReason: string,
    newResponse: string,
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    agentSettings: AgentSettings,
  ): [boolean, boolean] {
    const maxOutputTokens =
      stateGlobal.firstInputTokens > 0
        ? this.maxOutputTokensFactor * stateGlobal.firstInputTokens
        : Number.POSITIVE_INFINITY;

    const endTurn = ['end_turn', 'stop_sequence', 'stop'].includes(stopReason);
    const encounterDocumentTag = newResponse.includes(
      `</${agentSettings.documentTag}>`,
    );
    const continuationLimit = stateRound.continuationCount > this.continueLimit;
    const inputTokenLimit = stateGlobal.totalInputTokens > this.inputTokenLimit;
    const maxOutputTokensExceeded =
      stateGlobal.totalOutputTokens > maxOutputTokens;

    if (maxOutputTokensExceeded) {
      logger.warn(
        'ModelHandler',
        `Output tokens exceed ${this.maxOutputTokensFactor}x input tokens`,
      );
      logger.warn(
        'ModelHandler',
        `Total output tokens: ${stateGlobal.totalOutputTokens}, First input tokens: ${stateGlobal.firstInputTokens}`,
      );
    }

    const shouldStop =
      encounterDocumentTag || continuationLimit || inputTokenLimit;

    // Print debug info if stopping
    if (shouldStop) {
      logger.debug(
        'ModelHandler',
        `StopFlags:
                endTurn: ${endTurn}
                encounterDocumentTag: ${encounterDocumentTag}
                continuation_limit: ${continuationLimit}
                inputTokenLimit: ${inputTokenLimit}
                maxOutputTokens: ${maxOutputTokensExceeded}`,
      );
    }

    return [endTurn, shouldStop];
  }

  /** Get the appropriate client for this model. */
  abstract getClient(): any;

  /** Create a response using the model's API. */
  abstract createResponse(
    client: any,
    messages: any[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
  ): Promise<any>;

  /** Initialize messages for the conversation. */
  abstract initializeMessages(
    userPrefix: string,
    userRequest: string,
    figureFiles?: string[],
    systemPrompt?: string,
  ): Promise<any[]>;

  /** Create a reflection message. */
  abstract createReflectionMessage(
    messages: any[],
    userMessage: string,
    figureFiles?: string[],
  ): any[];

  /** Create image content for the model. */
  abstract createImageContent(imageContents: any[]): any[];

  /** Extract response text and usage statistics. */
  abstract extractResponse(
    responseObject: any,
    endTag: string,
    autoConfirmation?: boolean,
  ): [string, any, string];

  /** Handle continuation for truncated responses. */
  abstract addContinueMessage(
    messages: any[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSettings: AgentSettings,
    agentConfig: AgentConfig,
  ): void;

  /** Initialize output and handle prefill. */
  abstract initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSettings: AgentSettings,
    messages: any[],
    toolState: ToolState,
    outputFile: string,
    prefill: string,
  ): Promise<[boolean, any[]]>;

  /** Compute the price for token usage. */
  abstract computePrice(responseUsage: any): number;

  /** Compute model-specific response usage. */
  abstract computeResponseUsage(responseUsage: any, responseTime: number): any;

  /** Update message content. */
  abstract updateMessageContent(
    messages: any[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
    autoConfirmation?: boolean,
  ): void;

  /** Determine if the model should continue generating based on stop reason and response. */
  abstract shouldContinue(
    stopReason: string,
    newResponse: string,
    agentSettings: AgentSettings,
  ): boolean;
}
