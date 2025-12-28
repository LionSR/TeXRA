// Third-party imports
import { z, type ZodType } from 'zod';

// ============================================================================
// Tool Definition Schema - Single Source of Truth
// ============================================================================

/**
 * Zod schema for validating tool definition structure.
 * Single source of truth - type is derived via z.infer<>.
 *
 * Note: zodSchema uses z.custom<ZodType>() because ZodType instances can't be
 * validated by Zod itself. This field is runtime-only (added by defineTool(),
 * not present in YAML configs) but acknowledged in the schema for type safety.
 *
 * Uses passthrough() to allow forward compatibility with future runtime fields
 * without breaking validation when tools flow through AgentSettingSchema.
 */
export const ToolDefinitionSchema = z.looseObject({
  /** Name of the tool or function */
  name: z.string(),
  /** Optional description for the model */
  description: z.string().optional(),
  /** Parameter schema (JSON Schema format) */
  parameters: z.record(z.string(), z.unknown()).optional(),
  /** Runtime-only: original Zod schema for SDK-native conversion */
  zodSchema: z.custom<ZodType>().optional(),
});

/** Tool definition type - derived from schema */
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

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
