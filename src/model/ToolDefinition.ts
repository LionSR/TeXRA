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
 * Uses z.looseObject() to allow forward compatibility with future runtime
 * fields without breaking validation when tools flow through AgentSettingSchema.
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
  /** Runtime-only: do not infer a provider-native tool from this definition's name. */
  forceFunctionCall: z.boolean().optional(),
});

/** Tool definition type - derived from schema */
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
