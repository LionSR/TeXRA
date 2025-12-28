// Third-party imports
import { FinishReason } from '@google/genai';
import type { StopReason as AnthropicSDKStopReason } from '@anthropic-ai/sdk/resources/messages';

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
} as const;
export const OPENAI_CHAT_FINISH_REASONS = Object.values(OPENAI_CHAT_FINISH);
export type OpenAIChatFinishReason =
  | (typeof OPENAI_CHAT_FINISH_REASONS)[number]
  | null;

/**
 * Finish reasons for the legacy OpenAI text completion API.
 * The Responses API maps its status field to these values.
 */
export const OPENAI_COMPLETION_FINISH = {
  STOP: 'stop',
  LENGTH: 'length',
  CONTENT_FILTER: 'content_filter',
} as const;
export const OPENAI_COMPLETION_FINISH_REASONS = Object.values(
  OPENAI_COMPLETION_FINISH,
);
export type OpenAICompletionFinishReason =
  (typeof OPENAI_COMPLETION_FINISH_REASONS)[number];

/** Stop reasons defined in the Model Context Protocol SDK. */
export const MCP_STOP = {
  END_TURN: 'endTurn',
  STOP_SEQUENCE: 'stopSequence',
  MAX_TOKENS: 'maxTokens',
} as const;
export const MCP_STOP_REASONS = Object.values(MCP_STOP);
export type MCPStopReason = (typeof MCP_STOP_REASONS)[number];

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
/** Anthropic stop reason type - derived from SDK's StopReason */
export type AnthropicStopReason = AnthropicSDKStopReason;

/**
 * Finish reasons returned by Google's API.
 * Uses SDK's FinishReason enum directly as the single source of truth.
 */
export type GoogleFinishReason = FinishReason;

/**
 * Union type covering all known provider stop reasons.
 * Additional string values are allowed for providers without explicit enums.
 */
export type ProviderStopReason =
  | OpenAIChatFinishReason
  | OpenAICompletionFinishReason
  | AnthropicStopReason
  | GoogleFinishReason
  | MCPStopReason
  | string;
