// Union type for message objects used across model providers

// Third-party imports
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { Content } from '@google/genai';

/**
 * Message formats supported by the various model providers.
 */
export type ProviderMessage =
  | ChatCompletionMessageParam
  | ResponseInputItem
  | MessageParam
  | Content;
