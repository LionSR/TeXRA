// Third-party imports
import { z } from 'zod';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { Content } from '@google/genai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import type { ChatMessages as OpenRouterMessage } from '@openrouter/sdk/models';

/**
 * Message formats supported by the various model providers.
 */
export type ProviderMessage =
  | ChatCompletionMessageParam
  | ResponseInputItem
  | MessageParam
  | Content
  | OpenRouterMessage;

/**
 * Zod schema for ProviderMessage validation.
 *
 * Uses z.custom() because ProviderMessage is a union of external SDK types
 * (Anthropic, OpenAI, Google) that cannot be represented as native Zod schemas.
 * This is the correct and intentional use of z.custom() for external type unions.
 */
export const ProviderMessageSchema = z.custom<ProviderMessage>(
  (value): value is ProviderMessage =>
    typeof value === 'object' && value !== null,
  {
    error: 'messages must contain provider message objects',
  },
);
