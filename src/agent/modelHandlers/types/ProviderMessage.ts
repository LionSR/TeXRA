// Third-party imports
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { Content } from '@google/genai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ResponseInputItem } from 'openai/resources/responses/responses';

/**
 * Message formats supported by the various model providers.
 */
export type ProviderMessage =
  | ChatCompletionMessageParam
  | ResponseInputItem
  | MessageParam
  | Content;
