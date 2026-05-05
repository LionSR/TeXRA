// Third-party imports
import { FinishReason } from '@google/genai';
import type { StopReason as AnthropicSDKStopReason } from '@anthropic-ai/sdk/resources/messages';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import type { CompletionChoice } from 'openai/resources/completions';

/**
 * Finish reasons returned by the OpenAI Chat Completion API.
 * These are distinct from the Responses API status values.
 */
export const OPENAI_CHAT_FINISH = {
  STOP: 'stop',
  LENGTH: 'length',
  TOOL_CALLS: 'tool_calls',
  CONTENT_FILTER: 'content_filter',
  FUNCTION_CALL: 'function_call',
} as const satisfies Record<string, NonNullable<OpenAIChatFinishReason>>;
export type OpenAIChatFinishReason = ChatCompletion.Choice['finish_reason'];

/**
 * Finish reasons for the legacy OpenAI text completion API.
 * The Responses API maps its status field to these values.
 */
export const OPENAI_COMPLETION_FINISH = {
  STOP: 'stop',
  LENGTH: 'length',
  CONTENT_FILTER: 'content_filter',
} as const satisfies Record<string, NonNullable<OpenAICompletionFinishReason>>;
export type OpenAICompletionFinishReason = CompletionChoice['finish_reason'];

/** Stop reasons defined in the Model Context Protocol SDK. */
export const MCP_STOP = {
  END_TURN: 'endTurn',
  STOP_SEQUENCE: 'stopSequence',
  MAX_TOKENS: 'maxTokens',
} as const;
export type MCPStopReason = (typeof MCP_STOP)[keyof typeof MCP_STOP];

/**
 * Stop reasons for Anthropic models.
 * Runtime constants for comparison - values match SDK's StopReason type.
 */
export const ANTHROPIC_STOP = {
  END_TURN: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  STOP_SEQUENCE: 'stop_sequence',
  TOOL_USE: 'tool_use',
  PAUSE_TURN: 'pause_turn',
  REFUSAL: 'refusal',
} as const satisfies Record<string, AnthropicSDKStopReason>;

/**
 * Union type covering all known provider stop reasons.
 * Additional string values are allowed for providers without explicit enums.
 */
export type ProviderStopReason =
  | OpenAIChatFinishReason
  | OpenAICompletionFinishReason
  | AnthropicSDKStopReason
  | FinishReason
  | MCPStopReason
  | string;
