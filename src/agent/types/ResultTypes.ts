// Third-party imports
/**
 * Common result schemas used across utilities.
 */
import { z } from 'zod';

export const ExecResultSchema = z.object({
  /** Indicates whether the command succeeded */
  success: z.boolean(),
  /** Standard output from the command, if available */
  stdout: z.string().nullable(),
  /** Standard error from the command, if available */
  stderr: z.string().nullable(),
  /** True if the command timed out */
  timedOut: z.boolean().optional(),
});

export type ExecResult = z.infer<typeof ExecResultSchema>;

export type FileOpStatus = 'success' | 'noFiles' | 'missingParams' | 'error';

export const FileOpResultSchema = z.object({
  /** Outcome of the pack or clean operation */
  status: z.union([
    z.literal('success'),
    z.literal('noFiles'),
    z.literal('missingParams'),
    z.literal('error'),
  ]),
  /** Output directory if files were packed */
  outputFolder: z.string().optional(),
  /** Error message when status is "error" */
  error: z.string().optional(),
});

export type FileOpResult = z.infer<typeof FileOpResultSchema>;
