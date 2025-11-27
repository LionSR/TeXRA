/**
 * Centralized SDK type guards for OpenAI-compatible APIs.
 *
 * This module provides type guards and utilities for working with SDK types,
 * establishing a single source of truth for type discrimination.
 */

// Re-export SDK type guards from OpenAI SDK
export {
  isAssistantMessage,
  isToolMessage,
  isPresent,
} from 'openai/lib/chatCompletionUtils';

// Re-export parser utilities
export { isChatCompletionFunctionTool } from 'openai/lib/parser';

// Re-export provider tool call type guards
export {
  isOpenAIToolCall,
  isDeepSeekToolCall,
  isOpenAIResponseToolCall,
  isGoogleToolCall,
  isAnthropicToolCall,
  isOpenAICompatibleToolCall,
} from '../types/IModelHandler';

// Type imports
import type {
  ChatCompletionMessageToolCall,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageCustomToolCall,
  ChatCompletionMessage,
  ChatCompletionChunk,
} from 'openai/resources/chat/completions';

// ============================================================================
// Tool Call Type Guards
// ============================================================================

/**
 * Type guard for function tool calls using discriminated union.
 * Works with ChatCompletionMessageToolCall types that have a 'type' discriminant.
 *
 * Also handles the union with legacy ChatCompletionMessage.FunctionCall format.
 * Legacy FunctionCall does not have a 'type' field, so this returns false for those.
 */
export function isFunctionToolCall(
  call: ChatCompletionMessageToolCall | ChatCompletionMessage.FunctionCall,
): call is ChatCompletionMessageFunctionToolCall {
  // Modern tool calls have a 'type' discriminant
  if ('type' in call && call.type === 'function') {
    return true;
  }
  return false;
}

/**
 * Type guard for custom tool calls.
 * Legacy FunctionCall format does not support custom tools, so this
 * only checks the modern ChatCompletionMessageToolCall format.
 */
export function isCustomToolCall(
  call: ChatCompletionMessageToolCall | ChatCompletionMessage.FunctionCall,
): call is ChatCompletionMessageCustomToolCall {
  // Modern tool calls have a 'type' discriminant
  if ('type' in call && call.type === 'custom') {
    return true;
  }
  return false;
}

/**
 * Type guard to check if a tool call is the legacy FunctionCall format.
 * Legacy format has 'name' and 'arguments' but no 'type' field.
 */
export function isLegacyFunctionCall(
  call: ChatCompletionMessageToolCall | ChatCompletionMessage.FunctionCall,
): call is ChatCompletionMessage.FunctionCall {
  return !('type' in call) && 'name' in call && 'arguments' in call;
}

/**
 * Type guard to check if a value is a ChatCompletionMessageToolCall.
 * Handles both modern function tool calls and legacy FunctionCall format.
 */
export function isToolCallLike(
  value: unknown,
): value is ChatCompletionMessageToolCall | ChatCompletionMessage.FunctionCall {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;

  // Modern tool call format (has 'type' field)
  if ('type' in obj && (obj.type === 'function' || obj.type === 'custom')) {
    return 'id' in obj;
  }

  // Legacy FunctionCall format (has 'name' and 'arguments', no 'type')
  if ('name' in obj && 'arguments' in obj && !('type' in obj)) {
    return true;
  }

  return false;
}

/**
 * Check if a function tool call has valid data for extraction.
 * Ensures the tool call has an id and function name.
 */
export function hasValidFunctionData(
  call: ChatCompletionMessageFunctionToolCall,
): call is ChatCompletionMessageFunctionToolCall & {
  id: string;
  function: { name: string; arguments: string };
} {
  return (
    typeof call.id === 'string' &&
    call.id.length > 0 &&
    typeof call.function?.name === 'string' &&
    call.function.name.length > 0
  );
}

// ============================================================================
// Message Content Type Guards
// ============================================================================

/**
 * Type guard to check if message content is a string.
 */
export function isStringContent(content: unknown): content is string {
  return typeof content === 'string';
}

/**
 * Type guard to check if message content is an array (multi-part content).
 */
export function isArrayContent(content: unknown): content is unknown[] {
  return Array.isArray(content);
}

// ============================================================================
// Delta Type Guards for Streaming
// ============================================================================

/**
 * Extended delta type for reasoning models that include reasoning_content.
 * This is provider-specific (e.g., DeepSeek, o1 models).
 */
export interface ReasoningDelta extends ChatCompletionChunk.Choice.Delta {
  reasoning_content?: string | Array<{ type: string; text?: string }>;
}

/**
 * Type guard to check if a streaming delta contains reasoning content.
 */
export function hasReasoningContent(
  delta: ChatCompletionChunk.Choice.Delta,
): delta is ReasoningDelta {
  return 'reasoning_content' in delta;
}

/**
 * Type guard to check if a streaming delta has content.
 */
export function hasDeltaContent(
  delta: ChatCompletionChunk.Choice.Delta,
): delta is ChatCompletionChunk.Choice.Delta & { content: string } {
  return typeof delta.content === 'string';
}

/**
 * Type guard to check if a streaming delta has tool calls.
 */
export function hasDeltaToolCalls(
  delta: ChatCompletionChunk.Choice.Delta,
): delta is ChatCompletionChunk.Choice.Delta & {
  tool_calls: ChatCompletionChunk.Choice.Delta.ToolCall[];
} {
  return Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
}

// ============================================================================
// Generic Utility Type Guards
// ============================================================================

/**
 * Type guard to check if a value is a non-null object (record).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Type guard to check if a value is a non-empty string.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Type guard to check if an object has a specific property.
 */
export function hasProperty<K extends string>(
  obj: unknown,
  key: K,
): obj is Record<K, unknown> {
  return isRecord(obj) && key in obj;
}

/**
 * Type guard to check if an object has a string property.
 */
export function hasStringProperty<K extends string>(
  obj: unknown,
  key: K,
): obj is Record<K, string> {
  return hasProperty(obj, key) && typeof obj[key] === 'string';
}
