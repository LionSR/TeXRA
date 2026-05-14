/**
 * Common result schemas used across utilities.
 */
// Third-party imports
import { z } from 'zod';

const ExecResultSchema = z.strictObject({
  /** Indicates whether the command succeeded */
  success: z.boolean(),
  /** Standard output from the command, if available */
  stdout: z.string().nullable(),
  /** Standard error from the command, if available */
  stderr: z.string().nullable(),
  /** True if the command timed out */
  timedOut: z.boolean().optional(),
  /** Exit code from the command (undefined if not available) */
  exitCode: z.int().optional(),
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
