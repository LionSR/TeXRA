import { z, type ZodType } from 'zod';

import { AgentCategorySchema } from './agent';

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
  /**
   * Agent category this delegation tool launches, or the categories when it
   * launches either (`agent`), whose agents the run's delegation targets
   * list. Declared by the tool itself — never a side table mapping tool
   * names to categories.
   */
  availabilityCategory: z
    .union([AgentCategorySchema, z.array(AgentCategorySchema).readonly()])
    .optional(),
  /**
   * What a script's call of the tool resolves to, as a TypeScript type, when
   * it is not `ToolOutput` (`{ output, summary }`): a tool whose result
   * carries a `value` declares that value's type here.
   */
  scriptReturns: z.string().optional(),
});

/** Tool definition type - derived from schema */
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
