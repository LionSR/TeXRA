// Third-party imports
import { z, type ZodType } from 'zod';

// Third-party imports - provider tool definitions
import type { FunctionDefinition } from 'openai/resources/shared';
import type { Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { Schema as GeminiSchema } from '@google/genai/dist/genai';

/**
 * Zod schema for validating tool definitions from YAML configs and external sources.
 *
 * Note: The zodSchema field is a runtime-only property added by defineTool() and
 * is not part of this validation schema. It's only present on the TypeScript type.
 */
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
 * This type extends the validated schema with:
 * - Provider-specific parameter types for better type inference
 * - Runtime-only zodSchema field (added by defineTool(), not from YAML)
 */
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema> & {
  parameters?:
    | FunctionDefinition['parameters']
    | AnthropicTool['input_schema']
    | GeminiSchema;
  /**
   * Original Zod schema for SDK-native Zod support (runtime-only, not serialized).
   * When present, conversion functions use native toJSONSchema() for conversion.
   * Added by defineTool() - not present in YAML configs or validated by schema.
   */
  zodSchema?: ZodType;
};
