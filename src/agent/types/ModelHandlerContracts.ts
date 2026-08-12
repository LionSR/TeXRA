// Local imports
import type { ProviderUsage } from '@agent/core/usage/ResponseUsage';
import type { ToolDefinition } from '@model/ToolDefinition';
import type { LanguageModelToolCallPart } from '@platform/languageModel';

// Local file imports
import type { ProviderMessage } from './ProviderMessage';
import type { ProviderStopReason } from './StopReasonTypes';

// Third-party imports
import type {
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import type { ResponseFunctionToolCallItem } from 'openai/resources/responses/responses';
import type { FunctionCall } from '@google/genai';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages';
import type { ChatToolCall as ORChatToolCall } from '@openrouter/sdk/models';

/**
 * Plain data contracts shared between the {@link ModelHandler} base class and
 * the {@link IModelHandler} port derived from it.
 *
 * These types live in their own module (rather than in `IModelHandler.ts` or
 * `ModelHandler.ts` directly) so that `ModelHandler.ts` can depend on them
 * without depending on `IModelHandler.ts` — and `IModelHandler.ts` can depend
 * on both this module and `ModelHandler.ts` (for its `Pick`) without creating
 * a cycle. Don't move these back into either of those two files.
 */

/** User-selected credential source requested for a newly constructed client. */
export type ModelCredentialSelection = 'configured' | 'personal';

/** Credential route actually captured by an immutable provider client. */
export type ModelCredentialRoute =
  | 'api-key'
  | 'chatgpt-subscription'
  | 'xai-subscription'
  | 'openrouter'
  | 'relay';

export interface ResolvedClientCredential {
  readonly apiKey: string;
  readonly baseUrl: string | null;
  readonly route: Exclude<
    ModelCredentialRoute,
    'chatgpt-subscription' | 'xai-subscription'
  >;
}

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

/** Named terminal tool selected for a provider-native forced turn. */
export interface FinalTool {
  name: string;
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
  /** Specific terminal tool to force for this response, when supported. */
  finalTool?: FinalTool;
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

/**
 * Shared tool-call base. Members of {@link SdkToolCall} specialize this with
 * their provider literal, input, and raw wire type. Provider-specific extras
 * (e.g. Google `thoughtSignature`) are intersected at the alias, not via a
 * default `Record<string, never>` Extra — that intersection is uninhabitable
 * for objects with known keys under current TypeScript.
 */
type ToolCallBase<P extends string, I, R> = {
  provider: P;
  callId: string;
  name: string;
  input: I;
  raw: R;
};

export type OpenAIToolCall = ToolCallBase<
  'openai',
  ChatCompletionMessageFunctionToolCall['function']['arguments'],
  ChatCompletionMessageToolCall
>;

export type DeepSeekToolCall = ToolCallBase<
  'deepseek',
  unknown,
  ChatCompletionMessageToolCall
>;

export type OpenAIResponseToolCall = ToolCallBase<
  'openai-response',
  unknown,
  ResponseFunctionToolCallItem
>;

export type GoogleToolCall = ToolCallBase<
  'google',
  FunctionCall['args'],
  FunctionCall
> & { thoughtSignature?: string };

export type AnthropicToolCall = ToolCallBase<
  'anthropic',
  ToolUseBlock['input'],
  ToolUseBlock
>;

export type OpenRouterToolCall = ToolCallBase<
  'openrouter',
  unknown,
  ORChatToolCall
>;

export type VscodeLmToolCall = ToolCallBase<
  'vscode-lm',
  object,
  LanguageModelToolCallPart
>;

export type SdkToolCall =
  | OpenAIToolCall
  | DeepSeekToolCall
  | OpenAIResponseToolCall
  | GoogleToolCall
  | AnthropicToolCall
  | OpenRouterToolCall
  | VscodeLmToolCall;

// Note: SdkToolCall is a discriminated union on 'provider'.
// Use `call.provider === 'openai'` directly for type narrowing instead of
// separate type guard functions.
