// Third-party imports
import { z } from 'zod';

/**
 * Zod schema for command execution results.
 */
export const ExecResultSchema = z
  .object({
    /** Indicates whether the command succeeded */
    success: z.boolean(),
    /** Standard output from the command, if available */
    stdout: z.string().nullable(),
    /** Standard error from the command, if available */
    stderr: z.string().nullable(),
    /** True if the command timed out */
    timedOut: z.boolean().optional(),
  })
  .strict();

export type ExecResult = z.infer<typeof ExecResultSchema>;

export const FileOpStatusSchema = z.enum([
  'success',
  'noFiles',
  'missingParams',
  'error',
] as const);
export type FileOpStatus = z.infer<typeof FileOpStatusSchema>;

export const FileOpResultSchema = z
  .object({
    /** Outcome of the pack or clean operation */
    status: FileOpStatusSchema,
    /** Output directory if files were packed */
    outputFolder: z.string().optional(),
    /** Error message when status is "error" */
    error: z.string().optional(),
  })
  .strict();

export type FileOpResult = z.infer<typeof FileOpResultSchema>;
