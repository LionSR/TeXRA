/**
 * Zod schemas and type guards for provider message validation.
 *
 * This module provides proper runtime validation for the ProviderMessage union type,
 * which represents messages from different AI providers (OpenAI, Anthropic, Google).
 *
 * The schemas here are intentionally permissive for the message content to allow
 * provider-specific extensions, but they validate the discriminating fields that
 * identify which provider format a message belongs to.
 */

// Third-party imports
import { z } from 'zod';

// Type imports
import type { ProviderMessage } from './ProviderMessage';

/**
 * OpenAI Chat Completion message roles.
 * @see https://platform.openai.com/docs/api-reference/chat/create
 */
const OPENAI_CHAT_ROLES = ['system', 'user', 'assistant', 'tool', 'function', 'developer'] as const;

/**
 * Anthropic message roles.
 * @see https://docs.anthropic.com/en/api/messages
 */
const ANTHROPIC_ROLES = ['user', 'assistant'] as const;

/**
 * Google Gemini content roles.
 * @see https://ai.google.dev/api/generate-content
 */
const GOOGLE_ROLES = ['user', 'model', 'function', 'system'] as const;

/**
 * OpenAI Responses API item types.
 * @see https://platform.openai.com/docs/api-reference/responses
 */
const OPENAI_RESPONSE_ITEM_TYPES = [
  'message',
  'function_call',
  'function_call_output',
  'item_reference',
  'file_search_call',
  'computer_call',
  'computer_call_output',
  'reasoning',
  'image_generation_call',
  'code_interpreter_call',
  'local_shell_call',
  'local_shell_call_output',
  'mcp_list_tools',
  'mcp_call_tool',
  'mcp_call_tool_result',
  'mcp_list_resources',
  'mcp_read_resource',
  'web_search_call',
] as const;

/**
 * Schema for OpenAI Chat Completion messages.
 * Validates the structure of ChatCompletionMessageParam.
 */
export const OpenAIChatMessageSchema = z.object({
  role: z.enum(OPENAI_CHAT_ROLES),
  content: z.unknown(), // Content varies by role
  name: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
  tool_call_id: z.string().optional(),
  function_call: z.unknown().optional(),
});

/**
 * Schema for OpenAI Responses API items.
 * Validates the structure of ResponseInputItem.
 */
export const OpenAIResponseItemSchema = z.object({
  type: z.enum(OPENAI_RESPONSE_ITEM_TYPES),
  id: z.string().optional(),
  // Other fields vary by type
}).passthrough();

/**
 * Schema for Anthropic messages.
 * Validates the structure of MessageParam.
 */
export const AnthropicMessageSchema = z.object({
  role: z.enum(ANTHROPIC_ROLES),
  content: z.union([
    z.string(),
    z.array(z.object({
      type: z.string(),
    }).passthrough()),
  ]),
});

/**
 * Schema for Google Gemini content.
 * Validates the structure of Content.
 */
export const GoogleContentSchema = z.object({
  role: z.enum(GOOGLE_ROLES).optional(),
  parts: z.array(z.object({}).passthrough()),
});

/**
 * Type guard to check if a message is an OpenAI Responses API item.
 * ResponseInputItem is distinguished by having a `type` field.
 */
export function isOpenAIResponseItem(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.type === 'string' &&
    OPENAI_RESPONSE_ITEM_TYPES.includes(obj.type as typeof OPENAI_RESPONSE_ITEM_TYPES[number])
  );
}

/**
 * Type guard to check if a message is an OpenAI Chat Completion message.
 * ChatCompletionMessageParam has `role` but NOT `type` or `parts`.
 */
export function isOpenAIChatMessage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.role === 'string' &&
    OPENAI_CHAT_ROLES.includes(obj.role as typeof OPENAI_CHAT_ROLES[number]) &&
    !('type' in obj) && // Not a ResponseInputItem
    !('parts' in obj) // Not Google Content
  );
}

/**
 * Type guard to check if a message is an Anthropic message.
 * MessageParam has `role` (user/assistant only) and `content` (string or array of blocks).
 */
export function isAnthropicMessage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.role === 'string' &&
    ANTHROPIC_ROLES.includes(obj.role as typeof ANTHROPIC_ROLES[number]) &&
    'content' in obj &&
    !('parts' in obj) && // Not Google Content
    !('type' in obj) // Not ResponseInputItem
  );
}

/**
 * Type guard to check if a message is Google Gemini content.
 * Content is distinguished by having a `parts` array.
 */
export function isGoogleContent(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    Array.isArray(obj.parts) &&
    (obj.role === undefined ||
      (typeof obj.role === 'string' &&
        GOOGLE_ROLES.includes(obj.role as typeof GOOGLE_ROLES[number])))
  );
}

/**
 * Validates that a value is a valid ProviderMessage.
 * Checks against all supported provider message formats.
 */
export function isValidProviderMessage(value: unknown): value is ProviderMessage {
  return (
    isOpenAIResponseItem(value) ||
    isOpenAIChatMessage(value) ||
    isAnthropicMessage(value) ||
    isGoogleContent(value)
  );
}

/**
 * Identifies which provider format a message belongs to.
 * Returns null if the message format is not recognized.
 */
export function identifyMessageProvider(
  value: unknown,
): 'openai-chat' | 'openai-response' | 'anthropic' | 'google' | null {
  if (isOpenAIResponseItem(value)) return 'openai-response';
  if (isOpenAIChatMessage(value)) return 'openai-chat';
  if (isAnthropicMessage(value)) return 'anthropic';
  if (isGoogleContent(value)) return 'google';
  return null;
}

/**
 * Zod schema for ProviderMessage with proper validation.
 *
 * This schema validates that the value matches one of the supported provider
 * message formats, providing better error messages than a simple type check.
 */
export const ProviderMessageSchema = z.custom<ProviderMessage>(
  (value): value is ProviderMessage => {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    return isValidProviderMessage(value);
  },
  {
    message:
      'Invalid provider message format. Expected OpenAI ChatCompletionMessageParam, ' +
      'OpenAI ResponseInputItem, Anthropic MessageParam, or Google Content.',
  },
);

/**
 * Parses and validates a provider message, returning detailed error info on failure.
 */
export function parseProviderMessage(value: unknown): {
  success: true;
  data: ProviderMessage;
  provider: ReturnType<typeof identifyMessageProvider>;
} | {
  success: false;
  error: string;
} {
  const provider = identifyMessageProvider(value);
  if (provider === null) {
    const preview = JSON.stringify(value)?.slice(0, 100) ?? 'unknown';
    return {
      success: false,
      error: `Unrecognized message format: ${preview}...`,
    };
  }
  return {
    success: true,
    data: value as ProviderMessage,
    provider,
  };
}
