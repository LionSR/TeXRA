/**
 * Type guards for OpenAI SDK types.
 *
 * Note: The SDK provides some type guards in 'openai/lib/chatCompletionUtils':
 *   - isAssistantMessage, isToolMessage, isPresent
 * And in 'openai/lib/parser':
 *   - isChatCompletionFunctionTool (for tool DEFINITIONS, not calls)
 *
 * This module provides guards for tool CALLS and provider-specific extensions
 * that the SDK doesn't cover.
 */

import type {
  ChatCompletionMessageToolCall,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageCustomToolCall,
  ChatCompletionMessage,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions';

// ============================================================================
// Tool Call Type Guards (SDK doesn't provide these for tool CALLS)
// ============================================================================

/**
 * Type guard for function tool calls using discriminated union.
 * Note: SDK's `isChatCompletionFunctionTool` is for tool definitions, not calls.
 */
export function isFunctionToolCall(
  call: ChatCompletionMessageToolCall | ChatCompletionMessage.FunctionCall,
): call is ChatCompletionMessageFunctionToolCall {
  return 'type' in call && call.type === 'function';
}

/**
 * Type guard for custom tool calls.
 */
export function isCustomToolCall(
  call: ChatCompletionMessageToolCall | ChatCompletionMessage.FunctionCall,
): call is ChatCompletionMessageCustomToolCall {
  return 'type' in call && call.type === 'custom';
}

// ============================================================================
// Reasoning Model Extensions (provider-specific, not in SDK)
// ============================================================================

/**
 * Reasoning content can be a string or an array of content parts.
 * This is provider-specific (DeepSeek, o1 models).
 */
export type ReasoningContent = string | Array<{ type: string; text?: string }>;

/**
 * Extended delta type for reasoning models (DeepSeek, o1, etc.).
 * The SDK's ChatCompletionChunk.Choice.Delta doesn't include reasoning_content.
 */
export interface ReasoningDelta extends ChatCompletionChunk.Choice.Delta {
  reasoning_content?: ReasoningContent;
}

/**
 * Type guard for streaming deltas with reasoning content.
 */
export function hasReasoningContent(
  delta: ChatCompletionChunk.Choice.Delta,
): delta is ReasoningDelta {
  return 'reasoning_content' in delta;
}

/**
 * Extract text from reasoning content (handles both string and array formats).
 */
export function extractReasoningText(content: ReasoningContent | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map(item => item.text ?? '').join('');
}
