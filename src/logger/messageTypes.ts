// Third-party imports
import { z } from 'zod';

// Local imports
import type { TaskGroupStatus } from '@shared/schemas';

/**
 * End group status - terminal states used when finalizing log groups.
 * Single source of truth for end status in AgentLogger, LogEventSink, and transports.
 * This is a strict subset of TaskGroupStatus (only terminal states).
 *
 * ## Status Semantics
 *
 * - **STOPPED**: Flow completed successfully (all rounds finished normally).
 *   Despite the name, this does NOT mean "user stopped" - it means "finished".
 *   This naming comes from the UI status indicator showing "Stopped" when done.
 *
 * - **ERROR**: Flow terminated due to an error OR was interrupted by user.
 *   Use this for any non-successful termination.
 */
export const END_GROUP_STATUS = {
  /** Flow terminated due to error or user interruption */
  ERROR: 'error',
  /** Flow completed successfully (all rounds finished) */
  STOPPED: 'stopped',
} as const;

export const EndGroupStatusSchema = z.enum([
  END_GROUP_STATUS.ERROR,
  END_GROUP_STATUS.STOPPED,
]);

export type EndGroupStatus = z.infer<typeof EndGroupStatusSchema>;

// Compile-time assertion: EndGroupStatus must be a subset of TaskGroupStatus.
// This ensures type compatibility when assigning EndGroupStatus to TaskGroupStatus fields.
type _AssertEndGroupStatusSubset = EndGroupStatus extends TaskGroupStatus
  ? true
  : never;

/**
 * Schema for FILE_LIST message data entries.
 * Single source of truth for file list entry structure used by:
 * - AgentLogger.fileList() and logFileCategory()
 * - Progress view normalizers (normalizeFileListEntries)
 * - userVars.ts LoadedFileEntry type
 *
 * Note: The normalizer defaults missing `source` to 'unknown', so it's optional here.
 */
export const FileListEntrySchema = z.object({
  /** File path (absolute or relative) */
  path: z.string(),
  /** Whether the file was successfully loaded/found */
  ok: z.boolean(),
  /** Category source identifier (e.g., 'requiredFiles', 'Input Files'). Defaults to 'unknown' in normalizer. */
  source: z.string().optional(),
  /** Display label for the source (defaults to source if not provided) */
  sourceDisplay: z.string().optional(),
  /** Variable name if loaded for prompt variable substitution */
  varName: z.string().optional(),
  /** Whether this is an internal/bundled file */
  internal: z.boolean().optional(),
});

export type FileListEntry = z.infer<typeof FileListEntrySchema>;
