/**
 * Schemas for cross-launch stream restoration on the desktop app.
 *
 * Audit item D / trajectory #19. The desktop persists a slim snapshot
 * of the active stream rail when streams are created/updated and on
 * shutdown. On the next launch the snapshot is hydrated as
 * "ghost" entries on the rail so users can find their previous runs
 * — even though the live agent runtimes were killed when the app
 * exited. We deliberately do NOT try to re-attach to in-flight
 * agents; that requires reviving the runtime and is tracked
 * separately. A "Resume run" button surfaces in-rail and either
 * defers to existing storage-backed resume (when taskState exists)
 * or falls back to a clear "start fresh" prompt.
 */

import { z } from 'zod';

import { AgentCategorySchema } from './agent';
import { ExecutionIdSchema, StreamTabIdSchema } from './identifiers';
import { StreamStatusSchema } from './stream';

export const RESTORED_STREAM_FILE_VERSION = 1;

/**
 * Slim subset of `StreamTabInfo` + `StreamMetadata` that's safe to
 * persist to disk. We intentionally omit log entries, output files,
 * todos, badges, etc. — those would balloon the snapshot and we have
 * no way to faithfully resurrect them without the full runtime.
 */
export const RestoredStreamSnapshotSchema = z.object({
  /** Stream tab id (e.g. "agent@123"). Stable across relaunches. */
  streamId: StreamTabIdSchema,
  /** Display label used by the rail. */
  label: z.string(),
  /** Agent name that launched the stream (best-effort). */
  agent: z.string().optional(),
  agentCategory: AgentCategorySchema,
  /** Original input file (for workflow agents). */
  inputFile: z.string().optional(),
  /** Original instruction text — useful for "start fresh" fallback. */
  instruction: z.string().optional(),
  /** Last known status before shutdown. We mark it explicitly stopped
   * on hydrate so the UI doesn't claim the run is still running. */
  lastKnownStatus: StreamStatusSchema,
  /** AI-generated description, if any. */
  description: z.string().optional(),
  /** Execution id for storage lookup (powers resume / transcript view). */
  executionId: ExecutionIdSchema.optional(),
  /** Parent stream id for subagent streams, if this row is nested. */
  parentStreamId: StreamTabIdSchema.optional(),
  /** Original creation timestamp (ms since epoch). */
  creationTimestamp: z.number(),
  /** Last activity timestamp (ms since epoch) — used to sort the rail. */
  lastTimestamp: z.number().optional(),
  /** When the snapshot row itself was last persisted (ms since epoch). */
  persistedAt: z.number(),
});

export type RestoredStreamSnapshot = z.infer<
  typeof RestoredStreamSnapshotSchema
>;

/**
 * Versioned envelope persisted to `streams.json`. The version field
 * lets future schema changes detect older formats and migrate or
 * discard them gracefully — we treat a malformed/older file as
 * "no snapshot" and start over rather than crashing on launch.
 */
export const RestoredStreamsFileSchema = z.object({
  version: z.literal(RESTORED_STREAM_FILE_VERSION),
  streams: z.array(RestoredStreamSnapshotSchema),
});

export type RestoredStreamsFile = z.infer<typeof RestoredStreamsFileSchema>;

export function emptyRestoredStreamsFile(): RestoredStreamsFile {
  return { version: RESTORED_STREAM_FILE_VERSION, streams: [] };
}
