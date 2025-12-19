// Third-party imports
import { z, type ZodType } from 'zod';

// ============================================================================
// Tool Definition Schema - Single Source of Truth
// ============================================================================

/**
 * Zod schema for validating tool definition structure.
 * This is the SINGLE SOURCE OF TRUTH - types are derived from this schema.
 */
export const ToolDefinitionSchema = z.strictObject({
  /** Name of the tool or function */
  name: z.string(),
  /** Optional description for the model */
  description: z.string().optional(),
  /** Parameter schema (JSON Schema format) */
  parameters: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// Tool Definition Types - Derived from Schema
// ============================================================================

/**
 * Serializable tool definition - derived from schema.
 * Used for YAML configs, persistence, and validation.
 */
export type SerializableToolDefinition = z.infer<typeof ToolDefinitionSchema>;

/**
 * Full tool definition with runtime-only fields.
 * Extends the serializable type with fields that can't be validated by Zod.
 */
export type ToolDefinition = SerializableToolDefinition & {
  /**
   * Original Zod schema for SDK-native Zod support (runtime-only, not serialized).
   * When present, conversion functions use native toJSONSchema() for conversion.
   * Added by defineTool() - not present in YAML configs.
   */
  zodSchema?: ZodType;
};

// Compile-time assertion: ToolDefinition extends SerializableToolDefinition
type _AssertExtends = ToolDefinition extends SerializableToolDefinition
  ? true
  : never;
const _assertExtends: _AssertExtends = true;

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
