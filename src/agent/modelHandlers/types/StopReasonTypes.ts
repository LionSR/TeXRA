// Third-party imports
import { FinishReason } from '@google/genai';

/**
 * Finish reasons returned by the OpenAI Chat Completion API.
 * These are distinct from the Responses API status values.
 */
export const OPENAI_CHAT_FINISH = {
  STOP: 'stop',
  LENGTH: 'length',
  TOOL_CALLS: 'tool_calls',
  TOOL_USE: 'tool_use',
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

/** Status values used by the OpenAI Responses API. */
export const OPENAI_RESPONSE_STATUS = {
  COMPLETED: 'completed',
  FAILED: 'failed',
  IN_PROGRESS: 'in_progress',
  CANCELLED: 'cancelled',
  QUEUED: 'queued',
  INCOMPLETE: 'incomplete',
} as const;
export const OPENAI_RESPONSE_STATUSES = Object.values(OPENAI_RESPONSE_STATUS);
export type OpenAIResponseStatus = (typeof OPENAI_RESPONSE_STATUSES)[number];

/** Stop reasons defined in the Model Context Protocol SDK. */
export const MCP_STOP = {
  END_TURN: 'endTurn',
  STOP_SEQUENCE: 'stopSequence',
  MAX_TOKENS: 'maxTokens',
} as const;
export const MCP_STOP_REASONS = Object.values(MCP_STOP);
export type MCPStopReason = (typeof MCP_STOP_REASONS)[number];

/** Stop reasons for Anthropic models. */
export const ANTHROPIC_STOP = {
  END_TURN: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  STOP_SEQUENCE: 'stop_sequence',
  TOOL_USE: 'tool_use',
  PAUSE_TURN: 'pause_turn',
  REFUSAL: 'refusal',
} as const;
export const ANTHROPIC_STOP_REASONS = Object.values(ANTHROPIC_STOP);
export type AnthropicStopReason = (typeof ANTHROPIC_STOP_REASONS)[number];

/** Finish reasons returned by Google's API. */
export const GOOGLE_FINISH_REASONS = [
  FinishReason.FINISH_REASON_UNSPECIFIED,
  FinishReason.STOP,
  FinishReason.MAX_TOKENS,
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.LANGUAGE,
  FinishReason.OTHER,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.MALFORMED_FUNCTION_CALL,
  FinishReason.IMAGE_SAFETY,
  FinishReason.UNEXPECTED_TOOL_CALL,
] as const;
export type GoogleFinishReason = (typeof GOOGLE_FINISH_REASONS)[number];

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
