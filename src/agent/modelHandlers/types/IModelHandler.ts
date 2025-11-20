// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
// Internal imports
import { AgentSetting, AgentType } from '@agent/core/AgentDataclass';
import { ConversationRoundState, AgentRunState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
// Type imports
import type { MediaEntry } from '@agent/utils/mediaTypes';
import type { AgentLogger } from '@logger/AgentLogger';
import type { ModelConfig, ModelCapabilities, ToolDefinition } from '@model';
import type { FileLocation } from '@utils/files';
import type { ProviderMessage } from './ProviderMessage';
import type { ProviderStopReason } from './StopReasonTypes';
import type {
  ChatCompletionMessage,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import type { ResponseFunctionToolCallItem } from 'openai/resources/responses/responses';
import type { FunctionCall } from '@google/genai';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';

/**
 * Options for creating a model response.
 * @template M - Provider-specific message type
 */
export interface CreateResponseOptions<
  M extends ProviderMessage = ProviderMessage,
  C = unknown,
> {
  /** Provider client instance */
  client: C;
  /** Conversation messages */
  messages: M[];
  /** Sampling temperature (0-1) */
  temperature: number;
  /** Optional system prompt */
  systemPrompt?: string;
  /** Optional stop sequence */
  endTag?: string;
  /** Optional abort signal for cancellation */
  signal?: AbortSignal;
  /** Optional tool definitions for function calling */
  tools?: ToolDefinition[];
}

/**
 * Result from extracting response data from a provider response.
 */
export interface ExtractResponseResult {
  /** Extracted response text */
  response: string;
  /** Usage/token statistics from the provider */
  usage: any;
  /** Reason why the model stopped generating */
  stopReason: ProviderStopReason;
}

/**
 * Result from checking stop conditions.
 */
export interface StopConditionsResult {
  /** Whether the turn should end */
  endTurn: boolean;
  /** Whether generation should stop */
  shouldStop: boolean;
}

export type OpenAIToolCall = {
  provider: 'openai';
  callId: string;
  name: string;
  input:
    | ChatCompletionMessageFunctionToolCall['function']['arguments']
    | ChatCompletionMessage.FunctionCall['arguments'];
  raw: ChatCompletionMessageToolCall | ChatCompletionMessage.FunctionCall;
};

export type DeepSeekToolCall = {
  provider: 'deepseek';
  callId: string;
  name: string;
  input: unknown;
  raw: ChatCompletionMessageToolCall | ChatCompletionMessage.FunctionCall;
};

export type OpenAIResponseToolCall = {
  provider: 'openai-response';
  callId: string;
  name: string;
  input: unknown;
  raw: ResponseFunctionToolCallItem;
};

export type GoogleToolCall = {
  provider: 'google';
  callId: string;
  name: string;
  input: FunctionCall['args'];
  thoughtSignature?: string;
  raw: FunctionCall;
};

export type AnthropicToolCall = {
  provider: 'anthropic';
  callId: string;
  name: string;
  input: ToolUseBlock['input'];
  raw: ToolUseBlock;
};

export type SdkToolCall =
  | OpenAIToolCall
  | DeepSeekToolCall
  | OpenAIResponseToolCall
  | GoogleToolCall
  | AnthropicToolCall;

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
  T extends SdkToolCall = SdkToolCall,
  C = unknown,
  Resp = unknown,
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
   * @param options Options for creating the response
   */
  createResponse(options: CreateResponseOptions<M, C>): Promise<Resp>;

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
  extractResponse(responseObject: any, endTag: string): ExtractResponseResult;

  /** Handle continuation for models supporting prefill. */
  addContinueMessageWithPrefill(
    messages: M[],
    stateRound: ConversationRoundState,
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void;

  /** Handle continuation for models without prefill. */
  addContinueMessageWithoutPrefill(
    messages: M[],
    stateRound: ConversationRoundState,
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
    agentConfig: AgentConfig,
  ): void;

  /** Prepare output files and prefill content. */
  initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: M[],
    workspaceState: AgentWorkspaceState,
    outputLocation: FileLocation,
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
    workspaceState: AgentWorkspaceState,
  ): void;

  /** Update messages when prefill is not supported. */
  updateMessageContentWithoutPrefill(
    messages: M[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void;

  /** Determine whether generation should continue. */
  shouldContinue(
    stopReason: ProviderStopReason,
    newResponse: string,
    agentSetting: AgentSetting,
  ): boolean;

  /**
   * Evaluate whether to end the turn and/or stop generation.
   * @returns Object with endTurn and shouldStop flags
   */
  checkStopConditions(
    stopReason: ProviderStopReason,
    newResponse: string,
    stateRound: ConversationRoundState,
    stateGlobal: AgentRunState,
    agentSetting: AgentSetting,
  ): StopConditionsResult;

  /** Extract intermediate "thinking" content from a response. */
  processThinkingBlock(
    responseObject: any,
    workspaceState?: AgentWorkspaceState,
  ): string | null;

  /** Extract tool-use details from a provider response. */
  extractToolUse(responseObject: Resp): T[];

  /**
   * Create provider-specific messages capturing the tool call and result.
   *
   * @param call - Parsed tool call object or input payload
   * @param result - Object with output/error fields
   * @returns Tuple of [call message, result message]
   */
  createToolUseFollowUpMessages(
    client: C | undefined,
    call: T,
    result: Record<string, unknown>,
    workspaceState?: AgentWorkspaceState,
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
