/**
 * Zod schemas for stream-tab persistence.
 *
 * The `@agent`-free parsing schemas + legacy-flatten helpers now live in the
 * host-agnostic `@shared/schemas/streamData` so the shared `StreamSnapshotStore`
 * (core) and these extension managers decode identical on-disk shapes. They are
 * re-exported here so existing importers (managers, `StreamTabStore`) are
 * unchanged. Only `StreamTabMetaSchema` stays here — it embeds `TaskState`,
 * which would create a `src/shared → @agent` import cycle.
 */

import { z } from 'zod';

import { TaskStateSchema } from '@agent/core/execution/TaskState';

// ============================================================================
// Meta — small per-stream scalars consolidated into one file
// ============================================================================

export const StreamTabMetaSchema = z.object({
  /** Legacy field — no longer written, tolerated on read so we can skip it. */
  activeRunId: z.string().nullable().optional(),
  parentStreamId: z.string().optional(),
  executionId: z.string().optional(),
  taskState: TaskStateSchema.optional(),
  /** AI-generated session description, mirrored from ExecutionMeta for fast hydration. */
  description: z.string().optional(),
});

export type StreamTabMeta = z.infer<typeof StreamTabMetaSchema>;

// ============================================================================
// Re-exports of the relocated host-agnostic parsing helpers (source of truth:
// @shared/schemas/streamData). Keeps existing import sites working unchanged.
// ============================================================================

export {
  RoundKeySchema,
  LegacyInstructionEntrySchema,
  LegacyInstructionsDataSchema,
  selectPreferredLegacyInstruction,
  isLegacyNested,
  flattenLegacyRuns,
  OutputFilesDataSchema,
  MissingOutputsDataSchema,
  CompileFailuresDataSchema,
  TokenUsageStatsParsingSchema,
  isEmptyUsage,
  UsageDataSchema,
  type LegacyInstructionEntry,
  type OutputFilesRecord,
  type MissingOutputsRecord,
  type CompileFailuresRecord,
  type UsageStatsRecord,
} from '@shared/schemas/streamData';
