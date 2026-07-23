// Third-party imports
import { z } from 'zod';

// Local imports
import { ExecutionIdSchema } from '@shared/schemas';
import type { FileOpResult } from '@shared/schemas/opResults';

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

export type FileOpParams = z.infer<typeof FileOpParamsSchema>;

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

/**
 * Merges the runDir and workspace legs of an executionId-driven pack/clean
 * operation. Surfaces an error from either leg — a failed runDir
 * removal/snapshot must not be masked by a successful workspace sweep/pack —
 * and otherwise prefers the workspace result, falling back to the runDir
 * result only when the workspace leg found nothing (legacy runs whose
 * outputs still sit beside the source rather than inside the runDir).
 */
export function mergeRunDirAndWorkspaceResult(
  runDirResult: FileOpResult,
  workspaceResult: FileOpResult,
): FileOpResult {
  if (runDirResult.status === 'error') return runDirResult;
  if (workspaceResult.status === 'error') return workspaceResult;
  return workspaceResult.status !== 'noFiles' ? workspaceResult : runDirResult;
}
