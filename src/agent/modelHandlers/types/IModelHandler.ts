// Local imports - agent components
import type { AgentConfig } from '../../core/AgentConfig';
import { AgentSetting, AgentType } from '../../core/AgentDataclass';
import { AgentStateRound, AgentStateGlobal } from '../../core/AgentState';
import { ToolState } from '../../core/ToolState';
import type { MediaEntry } from '../../utils/mediaTypes';

// Local imports - provider types
import type { ProviderMessage } from './ProviderMessage';
import type { ProviderStopReason } from './StopReasonTypes';

// Local imports - logging and model metadata
import type { AgentLogger } from '@logger/AgentLogger';
import type { ModelConfig, ModelCapabilities, ToolDefinition } from '@model';

/**
 * Common interface implemented by all model handlers.
 *
 * @template M - Message type specific to the provider (e.g., MessageParam for Anthropic,
 *               ChatCompletionMessageParam for OpenAI). Must extend ProviderMessage.
 * @template U - Usage/statistics type returned by the provider's API response
 *               (e.g., Usage for Anthropic, CompletionUsage for OpenAI)
 * @template R - Processed response usage type for internal tracking
 *               (e.g., AnthropicAPIResponseUsage, OpenAIAPIResponseUsage)
 */
export interface IModelHandler<
  M extends ProviderMessage = ProviderMessage,
  U = any,
  R = any,
  T = unknown,
  C = unknown,
> {
  /** Model configuration used by the handler. */
  config: ModelConfig;

  /** Capabilities supported by the model. */
  capabilities: ModelCapabilities;

  /** Indicates if the model uses the OpenAI API. */
  readonly isOpenai: boolean;

  /** Indicates if the model is served by Anthropic. */
  readonly isAnthropic: boolean;

  /** Determine if streaming should be used for the current model. */
  getStreamingConfig(): boolean;

  /** Enable or disable streaming of model output text. */
  setOutputStreaming(enabled: boolean): void;

  /** Check if output streaming is enabled. */
  isOutputStreamingEnabled(): boolean;

  /** Indicates if the model is served by Google. */
  readonly isGoogle: boolean;

  /** Checks if the provider implements the OpenAI API. */
  readonly isOpenaiCompatible: boolean;

  /** Set the logger instance for the handler. */
  setLogger(logger: AgentLogger): void;

  /** Inform the handler about the active agent type. */
  setAgentType(agentType?: AgentType | null): void;

  /** Retrieve the agent type currently associated with the handler, if any. */
  getAgentType(): AgentType | undefined;

  /** Retrieve an authenticated client instance. */
  getClient(): Promise<C>;

  /**
   * Generate a response from the model.
   * @param client Provider client instance
   * @param messages Conversation messages
   * @param temperature Sampling temperature
   * @param systemPrompt Optional system prompt
   * @param endTag Optional stop sequence
   * @param signal Optional abort signal
   */
  createResponse(
    client: C,
    messages: M[],
    temperature: number,
    systemPrompt?: string,
    endTag?: string,
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): Promise<any>;

  /** Initialize the conversation for the first round. */
  initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: string[],
    systemPrompt?: string,
  ): Promise<M[]>;

  /** Create messages for a follow-up round. */
  createRoundMessages(
    messages: M[],
    userMessage: string,
    mediaFiles?: string[],
  ): Promise<M[]>;

  /** Format media content for provider APIs. */
  createMediaContent(mediaMessage: MediaEntry[]): any[];

  /** Extract the response text and usage from the provider response. */
  extractResponse(
    responseObject: any,
    endTag: string,
  ): [string, any, ProviderStopReason];

  /** Handle continuation for models supporting prefill. */
  addContinueMessageWithPrefill(
    messages: M[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void;

  /** Handle continuation for models without prefill. */
  addContinueMessageWithoutPrefill(
    messages: M[],
    stateRound: AgentStateRound,
    toolState: ToolState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void;

  /** Prepare output files and prefill content. */
  initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: M[],
    toolState: ToolState,
    outputFile: string,
    prefill: string,
  ): Promise<[boolean, M[]]>;

  /** Compute the cost for a response. */
  computePrice(responseUsage: U): number;

  /** Compute detailed usage metrics. */
  computeResponseUsage(responseUsage: U, responseTime: number): R;

  /** Update messages when prefill is supported. */
  updateMessageContentWithPrefill(
    messages: M[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void;

  /** Update messages when prefill is not supported. */
  updateMessageContentWithoutPrefill(
    messages: M[],
    bestConnector: string,
    newResponse: string,
    toolState: ToolState,
  ): void;

  /** Determine whether generation should continue. */
  shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean;

  /**
   * Evaluate whether to end the turn and/or stop generation.
   * @returns Tuple of [endTurn, shouldStop]
   */
  checkStopConditions(
    stopReason: ProviderStopReason,
    newResponse: string,
    stateRound: AgentStateRound,
    stateGlobal: AgentStateGlobal,
    agentSetting: AgentSetting,
  ): [boolean, boolean];

  /** Extract intermediate "thinking" content from a response. */
  processThinkingBlock(
    responseObject: any,
    groupId?: string,
    toolState?: ToolState,
  ): string | null;

  /** Extract tool-use details from a provider response. */
  extractToolUse(responseObject: any): string | null;

  /**
   * Create provider-specific messages capturing the tool call and result.
   *
   * @param id - Tool call identifier from the model response
   * @param name - Tool name
   * @param call - Parsed tool call object or input payload
   * @param result - Object with output/error fields
   * @returns Tuple of [call message, result message]
   */
  createToolUseFollowUpMessages(
    client: C | undefined,
    id: string,
    name: string,
    call: T,
    result: Record<string, unknown>,
    toolState?: ToolState,
    text?: string,
  ): Promise<M[]>;

  /**
   * Create provider-specific messages for a simple text follow-up.
   * Appends the user's message to the existing conversation array.
   */
  createUserFollowUpMessages(messages: M[], userMessage: string): Promise<M[]>;

  /**
   * Build a simple assistant message from plain text.
   */
  createAssistantMessage(text: string): M;

  /**
   * Determine if the stop reason represents an end-turn marker.
   */
  isEndTurnStop(reason: ProviderStopReason): boolean;
}
