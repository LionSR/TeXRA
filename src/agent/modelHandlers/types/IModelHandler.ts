// Local imports - agent components
import type { AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory, type AgentSetting } from '@agent/core/AgentDataclass';
import type {
  ConversationRoundStateSnapshot,
  AgentRunStateSnapshot,
} from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { ProviderUsage } from '@agent/core/ResponseUsage';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import type { MediaEntry } from '@agent/utils/mediaTypes';
import type { ToolResultPayload } from '@agent/modelHandlers/utils/toolAttachmentUtils';
import type { ToolDefinition } from '@model';
import type { ToolFileAttachment } from '@tools/result';
import type { FileLocation } from '@utils/files';
import type { ModelConfig, ModelCapabilities } from 'llm-zoo';
import type { ProviderMessage } from './ProviderMessage';
import type { ProviderStopReason } from './StopReasonTypes';
import type {
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import type { ResponseFunctionToolCallItem } from 'openai/resources/responses/responses';
import type { FunctionCall } from '@google/genai';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';
import type { ChatToolCall as ORChatToolCall } from '@openrouter/sdk/models';
import type { ServerToolExtractionResult } from './ServerToolTypes';

/**
 * Options for token counting - all fields optional, handlers use what they need.
 * @template C Provider-specific client type
 */
export interface TokenCountOptions<C = unknown> {
  /** Pre-authenticated client (avoids re-auth) */
  client?: C;
  /** System prompt to include in count */
  systemPrompt?: string;
  /** Tool definitions to include in count */
  tools?: unknown[];
  /** For cancellation */
  signal?: AbortSignal;
}

/**
 * Result from validating token limits against context window.
 */
export interface TokenValidationResult {
  /** Adjusted max tokens to fit within context window */
  adjustedMaxTokens: number;
  /** Input token count used for validation */
  inputTokens?: number;
  /** Percentage of context window utilized */
  utilizationPercent?: number;
}

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
 * Result from createResponse, optionally including updated messages
 * after compaction or other transformations.
 *
 * @template Resp - Provider-specific response type
 * @template M - Provider-specific message type
 */
export interface CreateResponseResult<
  Resp,
  M extends ProviderMessage = ProviderMessage,
> {
  /** The provider response */
  response: Resp;
  /**
   * If messages were transformed (e.g., compaction), the new array.
   * Undefined means messages were not modified - caller keeps original.
   */
  updatedMessages?: M[];
}

/**
 * Result from extracting response data from a provider response.
 */
export interface ExtractResponseResult {
  /** Extracted response text */
  text: string;
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

export type OpenRouterToolCall = {
  provider: 'openrouter';
  callId: string;
  name: string;
  input: unknown;
  raw: ORChatToolCall;
};

export type SdkToolCall =
  | OpenAIToolCall
  | DeepSeekToolCall
  | OpenAIResponseToolCall
  | GoogleToolCall
  | AnthropicToolCall
  | OpenRouterToolCall;

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
  config: ModelConfig;
  capabilities: ModelCapabilities;
  readonly isOpenai: boolean;
  readonly isAnthropic: boolean;

  getStreamingConfig(): boolean;
  setOutputStreaming(enabled: boolean): void;
  isOutputStreamingEnabled(): boolean;
  isBackgroundModeActive(): boolean;

  /** Whether this handler supports manual context compaction. */
  readonly supportsManualCompaction: boolean;

  /**
   * Request context compaction on the next API call.
   * For handlers that support it, this forces compaction regardless of the
   * automatic threshold. No-op for handlers that don't support compaction.
   */
  requestCompaction(): void;

  /** Returns the effective context window, accounting for beta overrides. */
  getEffectiveContextWindow(): number;

  readonly isGoogle: boolean;
  readonly isDeepSeek: boolean;
  readonly isKimi: boolean;
  readonly isMiniMax: boolean;

  /** Whether the handler supports processing attachments in tool results. */
  readonly canProcessToolResultAttachments: boolean;

  setLogger(logger: AgentTrace): void;
  setAgentCategory(agentCategory?: AgentCategory | null): void;
  getAgentCategory(): AgentCategory | undefined;
  getClient(): Promise<C>;

  /**
   * Generate a response from the model.
   * @param options Options for creating the response
   * @returns Result containing the response and optionally updated messages
   */
  createResponse(
    options: CreateResponseOptions<M, C>,
  ): Promise<CreateResponseResult<Resp, M>>;

  initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: FileLocation[],
    systemPrompt?: string,
  ): Promise<M[]>;

  createRoundMessages(
    messages: M[],
    userMessage: string,
    mediaFiles?: FileLocation[],
  ): Promise<M[]>;

  createMediaContent(mediaMessage: MediaEntry[]): unknown[];
  extractResponse(responseObject: Resp, endTag: string): ExtractResponseResult;

  addContinueMessageWithPrefill(
    messages: M[],
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
  ): void;

  addContinueMessageWithoutPrefill(
    messages: M[],
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
  ): void;

  initializeOutputAndPrefill(
    agentConfig: AgentConfig,
    agentSetting: AgentSetting,
    messages: M[],
    workspaceState: AgentWorkspaceState,
    outputLocation: FileLocation,
    prefill: string,
  ): Promise<[boolean, M[]]>;

  computePrice(responseUsage: U): number;

  /**
   * Normalizes provider-specific usage data into a unified format.
   * This is the single source of truth for usage statistics.
   * Cost is computed once here and should never be recomputed elsewhere.
   */
  normalizeUsage(rawUsage: U, responseTimeMs: number): NormalizedUsage;

  updateMessageContentWithPrefill(
    messages: M[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void;

  updateMessageContentWithoutPrefill(
    messages: M[],
    bestConnector: string,
    newResponse: string,
    workspaceState: AgentWorkspaceState,
  ): void;

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
    stateRound: ConversationRoundStateSnapshot,
    stateGlobal: AgentRunStateSnapshot,
    agentSetting: AgentSetting,
  ): StopConditionsResult;

  processThinkingBlock(
    responseObject: Resp,
    workspaceState?: AgentWorkspaceState,
  ): string | null;

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
   * Build an assistant message from a provider response.
   */
  createAssistantMessageFromResponse(responseObject: Resp, text: string): M;

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

  /**
   * Extract text from an assistant message in the conversation.
   * Returns undefined if the message is not an assistant message or has no text.
   *
   * Each provider implements this with proper typing for their message format
   * (e.g., role='assistant' for OpenAI/Anthropic, role='model' for Google).
   */
  extractAssistantText(message: M): string | undefined;

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
   * Used by MediaExtractionNode to add figures/PDFs after message building.
   *
   * @param messages - Existing messages array (mutated in place)
   * @param mediaFiles - Media files to add
   */
  addMediaToUserMessage(
    messages: M[],
    mediaFiles: FileLocation[],
  ): Promise<void>;

  /**
   * Release any resources held by the handler (e.g., WebSocket connections,
   * keepalive intervals). Called when the handler is no longer needed.
   * No-op by default.
   */
  dispose(): void;
}
