/**
 * Narrowing helpers for OpenAI Chat Completions `tool_calls` arrays.
 *
 * Local reimplementation of the openai SDK's
 * `assertToolCallsAreChatCompletionFunctionToolCalls` from `openai/lib/parser`,
 * which is the SDK source directory rather than a documented public export
 * path (`openai/resources/...` is the documented surface). Only the `function`
 * tool-call type is supported: a non-function entry throws so a malformed
 * provider payload surfaces loudly instead of being read as "no tool calls".
 * Shared by the OpenAI model handler (which lets the throw propagate to the
 * error-classification boundary) and the format-agnostic export normalizer
 * (which filters non-function entries out of a conversation).
 */

import { OpenAIError } from 'openai';
import type {
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

/** True when a chat-completions tool call is a `function` tool call. */
export function isFunctionToolCall(
  toolCall: ChatCompletionMessageToolCall,
): toolCall is ChatCompletionMessageFunctionToolCall {
  return toolCall.type === 'function';
}

/**
 * Assert that every entry in a `tool_calls` array is a `function` tool call,
 * narrowing the array to `ChatCompletionMessageFunctionToolCall[]`. Throws on
 * any non-function entry.
 */
export function assertToolCallsAreChatCompletionFunctionToolCalls(
  toolCalls: ChatCompletionMessageToolCall[] | null | undefined,
): asserts toolCalls is ChatCompletionMessageFunctionToolCall[] {
  for (const toolCall of toolCalls ?? []) {
    if (toolCall.type !== 'function') {
      throw new OpenAIError(
        `Currently only \`function\` tool calls are supported; Received \`${toolCall.type}\``,
      );
    }
  }
}
