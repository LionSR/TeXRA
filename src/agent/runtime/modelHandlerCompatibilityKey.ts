import { z } from 'zod';

export const MODEL_HANDLER_COMPATIBILITY_KEYS = [
  'ModelHandlerValidation',
  'ModelHandlerOpenAIResponse',
  'ModelHandlerOpenRouterNative',
  'ModelHandlerAnthropic',
  'ModelHandlerOpenAI',
  'ModelHandlerGoogleGenAI',
  'ModelHandlerGoogleInteractions',
  'ModelHandlerDeepSeek',
  'ModelHandlerXAI',
  'ModelHandlerKimi',
  'ModelHandlerDashScope',
  'ModelHandlerMiniMax',
  'ModelHandlerGLM',
] as const;

export type ModelHandlerCompatibilityKey =
  (typeof MODEL_HANDLER_COMPATIBILITY_KEYS)[number];

export const ModelHandlerCompatibilityKeySchema = z.enum(
  MODEL_HANDLER_COMPATIBILITY_KEYS,
);
