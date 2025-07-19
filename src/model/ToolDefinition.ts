// Third-party imports
import { z } from 'zod';

/** Zod schema describing a tool/function that a provider can execute. */
export const ToolDefinitionSchema = z
  .object({
    /** Name of the tool or function */
    name: z.string(),
    /** Optional description for the model */
    description: z.string().optional(),
    /** Parameter schema or provider specific metadata */
    parameters: z.record(z.unknown()).optional(),
  })
  .strict();

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
