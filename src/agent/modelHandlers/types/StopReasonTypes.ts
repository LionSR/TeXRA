// Third-party imports
import type { StopReason as AnthropicStopReason } from '@anthropic-ai/sdk/resources/messages/messages';
import type { FinishReason as GoogleFinishReason } from '@google/genai/dist/genai';

// Local imports - none

/** OpenAI finish reasons for chat completions. */
export type OpenAIFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'tool_use'
  | 'content_filter'
  | 'function_call'
  | null;

/** OpenAI finish reasons for text completions. */
export type OpenAICompletionFinishReason = 'stop' | 'length' | 'content_filter';

/** Stop reasons defined in the Model Context Protocol SDK. */
export type MCPStopReason = 'endTurn' | 'stopSequence' | 'maxTokens';

/**
 * Union type covering all known provider stop reasons.
 * Additional string values are allowed for providers without explicit enums.
 */
export type ProviderStopReason =
  | OpenAIFinishReason
  | OpenAICompletionFinishReason
  | AnthropicStopReason
  | GoogleFinishReason
  | MCPStopReason
  | string;
