// Third-party imports
import { z } from 'zod';

/**
 * Schema for validating housekeeping command configuration.
 * Shared by clean and pack commands.
 */
export const HousekeepingCommandConfigSchema = z
  .object({
    agent: z.string().min(1, 'agent is required'),
    model: z.string().min(1, 'model is required'),
    inputFile: z.string().min(1, 'inputFile is required'),
    outputFiles: z.array(z.string()).optional(),
    activeFiles: z
      .object({
        output: z.boolean().optional(),
      })
      .partial()
      .optional(),
    streamId: z.string().optional(),
  })
  .strict();

export type HousekeepingCommandConfig = z.infer<
  typeof HousekeepingCommandConfigSchema
>;
