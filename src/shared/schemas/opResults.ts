/**
 * Common result schemas used across utilities.
 */
// Third-party imports
import { z } from 'zod';

const ExecResultSchema = z.strictObject({
  /** Indicates whether the command succeeded */
  success: z.boolean(),
  /**
   * Standard output from the command. Empty or whitespace-only output is
   * normalized to the empty string by execUtils.normalizeOutput.
   */
  stdout: z.string(),
  /**
   * Standard error from the command. Empty or whitespace-only stderr is
   * normalized to the empty string, matching {@link ExecResult.stdout}.
   */
  stderr: z.string(),
  /** True if the command timed out */
  timedOut: z.boolean(),
  /** Exit code from the command */
  exitCode: z.int(),
  /** True when subprocess output exceeded the configured retained-output limit. */
  outputLimitExceeded: z.boolean().optional(),
});

export type ExecResult = z.infer<typeof ExecResultSchema>;

/** Status values for file operations - single source of truth */
const FileOpStatusSchema = z.enum([
  'success',
  'noFiles',
  'missingParams',
  'error',
]);

const FileOpResultSchema = z.strictObject({
  /** Outcome of the pack or clean operation */
  status: FileOpStatusSchema,
  /** Output directory if files were packed */
  outputFolder: z.string().optional(),
  /** Error message when status is "error" */
  error: z.string().optional(),
});

export type FileOpResult = z.infer<typeof FileOpResultSchema>;

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
