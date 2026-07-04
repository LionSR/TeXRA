// Local imports - agent components
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { ProviderUsage } from '@agent/core/usage/ResponseUsage';
import type { ToolDefinition } from '@model';
import type {
  ToolFileAttachment,
  ToolResult,
} from '@shared/schemas/toolResult';
import type { ModelHandler } from '../ModelHandler';
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
 * Common port implemented by all model handlers.
 *
 * Derived from {@link ModelHandler} via `Pick` so the port surface can never
 * drift from the base class: adding, renaming, or retyping a member there is
 * automatically reflected here, and a base-class signature change breaks
 * exactly one place (the class) instead of two. Only members consumers
 * actually call through this port are picked — internal-only members (e.g.
 * `computePrice`, `supportsReasoningLevelOverride`) are reached through the
 * concrete class instead and are intentionally omitted.
 *
 * `createBatchedToolUseFollowUpMessages` is the one thing this port expresses
 * that the class doesn't: it's an interface-only optional extension that
 * `ToolUseDispatchNode` feature-detects for providers requiring batched
 * parallel tool-result messages (e.g. Google, DeepSeek, Kimi, MiniMax).
 *
 * @template M - Message type specific to the provider (e.g., MessageParam for Anthropic,
 *               ChatCompletionMessageParam for OpenAI). Must extend ProviderMessage.
 * @template U - Usage/statistics type returned by the provider's API response
 *               (e.g., Usage for Anthropic, CompletionUsage for OpenAI)
 * @template T - Tool call type (defaults to the full SdkToolCall union)
 * @template C - Provider-specific client type
 * @template Resp - Provider-specific response object type
 */
export type IModelHandler<
  M extends ProviderMessage = ProviderMessage,
  U = unknown,
  T extends SdkToolCall = SdkToolCall,
  C = unknown,
  Resp = unknown,
> = Pick<
  ModelHandler<M, U, T, C, Resp>,
  | 'config'
  | 'capabilities'
  | 'isOpenai'
  | 'isAnthropic'
  | 'isGoogle'
  | 'getStreamingConfig'
  | 'setOutputStreaming'
  | 'isBackgroundModeActive'
  | 'supportsManualCompaction'
  | 'usesProviderManagedAutoRetry'
  | 'isAutoRetryManagedByProvider'
  | 'requestCompaction'
  | 'getEffectiveContextWindow'
  | 'requiresBatchedParallelToolResults'
  | 'setLogger'
  | 'setAgentCategory'
  | 'getClient'
  | 'createResponse'
  | 'initializeMessages'
  | 'createRoundMessages'
  | 'extractResponse'
  | 'addContinueMessageWithPrefill'
  | 'addContinueMessageWithoutPrefill'
  | 'initializeOutputAndPrefill'
  | 'normalizeUsage'
  | 'updateMessageContentWithPrefill'
  | 'updateMessageContentWithoutPrefill'
  | 'shouldContinue'
  | 'checkStopConditions'
  | 'processThinkingBlock'
  | 'extractToolUse'
  | 'extractServerToolData'
  | 'createToolUseFollowUpMessages'
  | 'createUserFollowUpMessages'
  | 'createAssistantMessageFromResponse'
  | 'isEndTurnStop'
  | 'extractAssistantContent'
  | 'extractAssistantText'
  | 'prependTextToUserMessage'
  | 'addMediaToUserMessage'
  | 'dispose'
> & {
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
    results: ToolResult[],
    attachmentsPerCall: ToolFileAttachment[][],
    workspaceState?: AgentWorkspaceState,
    text?: string,
  ): Promise<M[]>;
};
