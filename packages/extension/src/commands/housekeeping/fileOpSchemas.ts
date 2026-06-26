// Third-party imports
import { z } from 'zod';

// Local imports
import { ExecutionIdSchema } from '@shared/schemas';

/** Non-empty string for the required file-operation identity fields. */
const RequiredString = z.string().min(1);

/**
 * Identity shared by every pack/clean file operation: the input file plus the
 * agent and model that produced it. The single source of truth for both the
 * pack and clean command schemas and their parameter type.
 */
export const FileOpParamsSchema = z.object({
  inputFile: RequiredString,
  agent: RequiredString,
  model: RequiredString,
});

export type FileOpParams = z.infer<typeof FileOpParamsSchema>;

/**
 * Config-level fields shared by the pack and clean config schemas. Spread into
 * a base schema's `.extend(...)` so each command can still override an
 * individual field (pack permits an empty `model` in config, for example).
 */
export const fileOpConfigFields = {
  outputFiles: z.array(z.string()).prefault([]),
  streamId: z.string().optional(),
  executionId: ExecutionIdSchema.optional(),
  skipProgressViewClear: z.boolean().optional(),
};
