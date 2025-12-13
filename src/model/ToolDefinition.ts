// Third-party imports
import { z, type ZodType } from 'zod';

// Third-party imports - provider tool definitions
import type { FunctionDefinition } from 'openai/resources/shared';
import type { Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { Schema as GeminiSchema } from '@google/genai/dist/genai';

/** Zod schema describing a tool/function that a provider can execute. */
export const ToolDefinitionSchema = z.strictObject({
  /** Name of the tool or function */
  name: z.string(),
  /** Optional description for the model */
  description: z.string().optional(),
  /** Parameter schema or provider specific metadata */
  parameters: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Generic tool definition used across model providers. The parameters field
 * aligns with OpenAI, Anthropic and Google Gemini function schemas.
 *
 * When zodSchema is provided, SDK-native Zod helpers can be used for conversion,
 * avoiding manual JSON Schema transformation and enabling SDK-specific optimizations.
 */
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema> & {
  parameters?:
    | FunctionDefinition['parameters']
    | AnthropicTool['input_schema']
    | GeminiSchema;
  /**
   * Original Zod schema for SDK-native Zod support.
   * When present, conversion functions can use SDK helpers like:
   * - OpenAI: zodFunction() / zodResponsesFunction()
   * - Anthropic: betaZodTool() pattern (z.toJSONSchema)
   */
  zodSchema?: ZodType;
};
