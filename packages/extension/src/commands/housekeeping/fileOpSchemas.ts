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
const FileOpParamsSchema = z.object({
  inputFile: RequiredString,
  agent: RequiredString,
  model: RequiredString,
});

/** Positional arguments shared by the single-file pack and clean commands. */
export const FileOpCommandArgsSchema = z.tuple([
  FileOpParamsSchema.shape.inputFile,
  FileOpParamsSchema.shape.agent,
  FileOpParamsSchema.shape.model,
]);

/**
 * Config-level fields shared by the pack and clean config schemas. Spread into
 * a base schema's `.extend(...)` so each command can still override an
 * individual field (pack permits an empty `model` in config, for example).
 */
const fileOpConfigFields = {
  outputFiles: z.array(z.string()).prefault([]),
  streamId: z.string().optional(),
  executionId: ExecutionIdSchema.optional(),
  skipProgressViewClear: z.boolean().optional(),
};

export const PackConfigSchema = FileOpParamsSchema.extend({
  // Pack permits an empty model in config; clean keeps it required.
  model: z.string().prefault(''),
  ...fileOpConfigFields,
});

export type PackConfig = z.infer<typeof PackConfigSchema>;

export const CleanConfigSchema = FileOpParamsSchema.extend(fileOpConfigFields);

export type CleanConfig = z.infer<typeof CleanConfigSchema>;

/** Positional arguments for the multi-file pack command. */
export const PackMultipleCommandArgsSchema = z
  .tuple([
    z.string().prefault(''),
    FileOpParamsSchema.shape.agent,
    FileOpParamsSchema.shape.model,
    z.array(z.string()).prefault([]),
  ])
  .refine(([inputFile, , , inputFiles]) => inputFile || inputFiles.length > 0, {
    error: 'inputFile or inputFiles required',
  });

/** Positional arguments for the multi-file clean command. */
export const CleanMultipleCommandArgsSchema = z.tuple([
  FileOpParamsSchema.shape.inputFile,
  FileOpParamsSchema.shape.agent,
  FileOpParamsSchema.shape.model,
  z.array(z.string()).prefault([]),
]);
