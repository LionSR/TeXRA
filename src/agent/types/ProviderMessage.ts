// Third-party imports
import { z } from 'zod';
import type { LanguageModelMessage } from '@platform/languageModel';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { Content, Interactions } from '@google/genai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ResponseInputItem } from 'openai/resources/responses/responses';
import type { ChatMessages as OpenRouterMessage } from '@openrouter/sdk/models';

/**
 * Message formats supported by the provider SDKs and host language-model port.
 */
export type ProviderMessage =
  | ChatCompletionMessageParam
  | ResponseInputItem
  | MessageParam
  | Content
  | Interactions.Step
  | OpenRouterMessage
  | LanguageModelMessage;

/**
 * Zod schema for ProviderMessage validation.
 *
 * Uses z.custom() because ProviderMessage is a union of external SDK types
 * (Anthropic, OpenAI, Google, OpenRouter, and VS Code LM) that cannot be
 * represented as native Zod schemas.
 * This is the correct and intentional use of z.custom() for external type unions.
 *
 * The predicate stops short of full SDK shape validation (the union members
 * don't share one discriminant), but every member of the union carries a
 * top-level `role` or `type` string (or, for the legacy Gemini `Content`
 * shape whose `role` is optional, a `parts` array) — so requiring one of
 * those rejects arbitrary/corrupted objects while still accepting any real
 * provider message. Persisted conversation state is parsed through this
 * schema on session resume, so this is the boundary where corrupted data
 * should fail loudly instead of being silently trusted and surfacing as a
 * confusing error deep inside a model handler.
 */
const ProviderMessageSchema = z.custom<ProviderMessage>(
  (value): value is ProviderMessage =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (typeof (value as { role?: unknown }).role === 'string' ||
      typeof (value as { type?: unknown }).type === 'string' ||
      Array.isArray((value as { parts?: unknown }).parts)),
  {
    error: 'messages must contain provider message objects',
  },
);

export const ProviderMessageArraySchema = z.array(ProviderMessageSchema);
