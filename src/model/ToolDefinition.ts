// Third-party imports
import { z, type ZodType } from 'zod';

// Third-party imports - provider tool definitions
import type { FunctionDefinition } from 'openai/resources/shared';
import type { Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { Schema as GeminiSchema } from '@google/genai/dist/genai';

// ============================================================================
// Tool Definition Schema
// ============================================================================

/**
 * Zod schema for validating tool definition structure.
 *
 * Design notes:
 * - Uses z.object() (not strictObject) with passthrough() to allow runtime-only
 *   fields like `zodSchema` that are added by defineTool()
 * - The schema validates the serializable fields (name, description, parameters)
 * - The TypeScript `ToolDefinition` type provides full typing including runtime fields
 *
 * This separation is intentional:
 * - Schema: validates data structure from YAML/JSON
 * - Type: provides full TypeScript typing for runtime usage
 */
export const ToolDefinitionSchema = z
  .object({
    /** Name of the tool or function */
    name: z.string(),
    /** Optional description for the model */
    description: z.string().optional(),
    /** Parameter schema or provider specific metadata */
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

// ============================================================================
// Tool Definition Type
// ============================================================================

/**
 * Full tool definition type used across model providers.
 *
 * Note: This type is NOT derived from ToolDefinitionSchema via z.infer because:
 * 1. `parameters` needs provider-specific types (OpenAI, Anthropic, Gemini)
 * 2. `zodSchema` is a runtime-only field (ZodType can't be validated by Zod)
 *
 * The schema validates structure; this type provides TypeScript typing.
 */
export type ToolDefinition = {
  /** Name of the tool or function */
  name: string;
  /** Optional description for the model */
  description?: string;
  /** Parameter schema - accepts provider-specific formats */
  parameters?:
    | FunctionDefinition['parameters']
    | AnthropicTool['input_schema']
    | GeminiSchema;
  /**
   * Original Zod schema for SDK-native Zod support (runtime-only, not serialized).
   * When present, conversion functions use native toJSONSchema() for conversion.
   * Added by defineTool() - not present in YAML configs.
   */
  zodSchema?: ZodType;
};

// ============================================================================
// Type Guards and Utilities
// ============================================================================

/**
 * Check if a tool definition has a Zod schema attached.
 * Tools created via defineTool() will have this, YAML-loaded tools won't.
 */
export function hasZodSchema(
  def: ToolDefinition,
): def is ToolDefinition & { zodSchema: ZodType } {
  return def.zodSchema !== undefined;
}
