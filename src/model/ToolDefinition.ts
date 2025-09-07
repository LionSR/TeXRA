// Third-party imports
import { z } from 'zod';
// Third-party imports - provider tool definitions
import type { FunctionDefinition } from 'openai/resources/shared';
import type { Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { Schema as GeminiSchema } from '@google/genai/dist/genai';

/** Zod schema describing a tool/function that a provider can execute. */
export const ToolDefinitionSchema = z
  .object({
    /** Name of the tool or function */
    name: z.string(),
    /** Optional description for the model */
    description: z.string().optional(),
    /** Parameter schema or provider specific metadata */
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Generic tool definition used across model providers. The parameters field
 * aligns with OpenAI, Anthropic and Google Gemini function schemas.
 */
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema> & {
  parameters?:
    | FunctionDefinition['parameters']
    | AnthropicTool['input_schema']
    | GeminiSchema;
};
