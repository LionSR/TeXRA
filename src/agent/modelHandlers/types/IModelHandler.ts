// Local imports - agent components
import type { AgentConfig } from '@agent/core/AgentConfig';
// Internal imports
import { AgentSetting, AgentType } from '@agent/core/AgentDataclass';
import { ConversationRoundState, AgentRunState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { ProviderUsage } from '@agent/core/ResponseUsage';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
// Type imports
import type { MediaEntry } from '@agent/utils/mediaTypes';
import type { ToolResultPayload } from '@agent/modelHandlers/utils/toolAttachmentUtils';
import type { AgentLogger } from '@logger/AgentLogger';
import type { ModelConfig, ModelCapabilities, ToolDefinition } from '@model';
import type { ToolFileAttachment } from '@tools/result';
import type { FileLocation } from '@utils/files';
import type { ProviderMessage } from './ProviderMessage';
import type { ProviderStopReason } from './StopReasonTypes';
import type {
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import type { ResponseFunctionToolCallItem } from 'openai/resources/responses/responses';
import type { FunctionCall } from '@google/genai';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';
import type { ServerToolExtractionResult } from './ServerToolTypes';

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
  usage: ProviderUsage;
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
  input: ChatCompletionMessageFunctionToolCall['function']['arguments'];
  raw: ChatCompletionMessageToolCall;
};

export type DeepSeekToolCall = {
  provider: 'deepseek';
  callId: string;
  name: string;
  input: unknown;
  raw: ChatCompletionMessageToolCall;
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
  raw: FunctionCall;
  thoughtSignature?: string;
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

// Note: SdkToolCall is a discriminated union on 'provider'.
// Use `call.provider === 'openai'` directly for type narrowing instead of
// separate type guard functions.

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

  /** Check if background mode is active for this handler. */
  isBackgroundModeActive(): boolean;

  /** Indicates if the model is served by Google. */
  readonly isGoogle: boolean;

  /** Indicates if the model is served by DeepSeek. */
  readonly isDeepSeek: boolean;

  /** Whether the handler supports processing attachments in tool results. */
  readonly canProcessToolResultAttachments: boolean;

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
    mediaFiles?: FileLocation[],
    systemPrompt?: string,
  ): Promise<M[]>;

  /** Create messages for a follow-up round. */
  createRoundMessages(
    messages: M[],
    userMessage: string,
    mediaFiles?: FileLocation[],
  ): Promise<M[]>;

  /** Format media content for provider APIs. */
  createMediaContent(mediaMessage: MediaEntry[]): unknown[];

  /** Extract the response text and usage from the provider response. */
  extractResponse(responseObject: Resp, endTag: string): ExtractResponseResult;

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

  /**
   * Normalizes provider-specific usage data into a unified format.
   * This is the single source of truth for usage statistics.
   * Cost is computed once here and should never be recomputed elsewhere.
   */
  normalizeUsage(rawUsage: U, responseTimeMs: number): NormalizedUsage;

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
    responseObject: Resp,
    workspaceState?: AgentWorkspaceState,
  ): string | null;

  /** Extract tool-use details from a provider response. */
  extractToolUse(responseObject: Resp): T[];

  /**
   * Extract all server tool data from a provider response in a single pass.
   * Returns both normalized results for display and raw content blocks for context.
   * This is the single source of truth for server tool extraction.
   *
   * @param responseObject - The raw API response
   * @returns Combined extraction result with webSearchResults and contentBlocks
   */
  extractServerToolData(responseObject: Resp): ServerToolExtractionResult;

  /**
   * Create provider-specific messages capturing the tool call and result.
   *
   * @param client - Provider client (for file uploads if supported)
   * @param call - Parsed tool call object or input payload
   * @param result - Tool result payload (binary data stripped, properly typed)
   * @param attachments - Extracted file attachments (for upload/inline if supported)
   * @param workspaceState - Optional workspace state
   * @param text - Optional text to include before tool call
   * @returns Array of provider-specific messages
   */
  createToolUseFollowUpMessages(
    client: C | undefined,
    call: T,
    result: ToolResultPayload,
    attachments: ToolFileAttachment[],
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<M[]>;

  /**
   * Create provider-specific messages for MULTIPLE parallel tool calls.
   *
   * This is optional and primarily used by Google handlers to properly structure
   * parallel function calls with thought signatures (required for Gemini 3 models).
   *
   * When implemented:
   * - All function calls go in ONE model message (first call has thoughtSignature)
   * - All function responses go in ONE user message
   *
   * @param calls - Array of tool calls (preserving original order from model response)
   * @param results - Array of tool result payloads (same order as calls)
   * @param attachmentsPerCall - Array of attachment arrays (same order as calls)
   * @param workspaceState - Optional workspace state for reasoning blocks
   * @param text - Optional text to include before function calls
   */
  createBatchedToolUseFollowUpMessages?(
    calls: T[],
    results: ToolResultPayload[],
    attachmentsPerCall: ToolFileAttachment[][],
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

  /**
   * Extract assistant content blocks from a response, excluding tool_use blocks.
   * Used to preserve original order when building follow-up messages.
   *
   * @param responseObject - The raw API response
   * @returns Array of content blocks suitable for message building, or empty array if not supported
   */
  extractAssistantContent(responseObject: Resp): unknown[];

  // =========================================================================
  // Message modification methods (for post-build enrichment)
  // =========================================================================

  /**
   * Prepend text to the last user message in the conversation.
   * Used by TeXCountNode to add stats before the user's content.
   *
   * @param messages - Existing messages array (mutated in place)
   * @param text - Text to prepend
   */
  prependTextToUserMessage(messages: M[], text: string): void;

  /**
   * Add media files to the last user message in the conversation.
   * Used by MediaPreparationNode to add figures/PDFs after message building.
   *
   * @param messages - Existing messages array (mutated in place)
   * @param mediaFiles - Media files to add
   */
  addMediaToUserMessage(
    messages: M[],
    mediaFiles: FileLocation[],
  ): Promise<void>;
}
