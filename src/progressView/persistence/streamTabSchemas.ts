/**
 * Zod schemas for stream-tab persistence.
 *
 * Single source of truth for all data shapes read from / written to disk
 * by StreamTabStore, OutputFilesManager, and InstructionManager.
 *
 * Workflow streams hold one run per tab. Legacy disk data (from before the
 * one-run-per-tab refactor) was keyed by runId; union schemas here accept
 * both shapes and flatten legacy → new by picking the most recent run.
 */

import { z } from 'zod';

import { TaskStateSchema } from '@logger/TaskState';
import {
  InstructionUpdateSchema,
  OutputFileInfoSchema,
  TokenUsageStatsSchema,
  type InstructionUpdate,
  type OutputFileInfo,
  type TokenUsageStats,
} from '@shared/schemas';

// ============================================================================
// Shared: round key coercion
// ============================================================================

/** Coerces and validates integer round keys from string record keys. */
export const RoundKeySchema = z.coerce.number().int();

// ============================================================================
// Meta — small per-stream scalars consolidated into one file
// ============================================================================

export const StreamTabMetaSchema = z.object({
  /** Legacy field — no longer read/written; tolerated on read so we can skip it. */
  activeRunId: z.string().nullable().optional(),
  parentStreamId: z.string().optional(),
  executionId: z.string().optional(),
  taskState: TaskStateSchema.optional(),
  /** AI-generated session description, mirrored from ExecutionMeta for fast hydration. */
  description: z.string().optional(),
});

export type StreamTabMeta = z.infer<typeof StreamTabMetaSchema>;

// ============================================================================
// Shared transform helpers
// ============================================================================

/** Convert { stringKey: items[] } record to Map<number, items[]>, coercing keys. */
function recordToRoundMap<T>(record: Record<string, T[]>): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const [key, items] of Object.entries(record)) {
    const round = RoundKeySchema.safeParse(key);
    if (round.success && items.length > 0) {
      map.set(round.data, items);
    }
  }
  return map;
}

/**
 * Pick the last entry from a legacy run-keyed record, filtering out empty
 * values. Returns null/empty when no runs contain data.
 */
function pickLatestRunEntries<T>(
  record: Record<string, T>,
  isEmpty: (value: T) => boolean,
): T | null {
  let latest: T | null = null;
  for (const [, value] of Object.entries(record)) {
    if (!isEmpty(value)) latest = value;
  }
  return latest;
}

// ============================================================================
// Output files: { round: OutputFileInfo[] } (new) or { runId: { round: … } } (legacy)
// ============================================================================

const OutputFileListSchema = z
  .array(OutputFileInfoSchema.catch(null as unknown as OutputFileInfo))
  .transform((items) =>
    items.filter((item): item is OutputFileInfo => item !== null),
  )
  .catch([]);

/** New flat shape: { roundKey: OutputFileInfo[] } → Map<round, files>. */
const OutputFilesFlatSchema = z
  .record(z.string(), OutputFileListSchema)
  .transform(recordToRoundMap);

/** Legacy: { runId: { roundKey: OutputFileInfo[] } } → pick latest run's map. */
const OutputFilesLegacySchema = z
  .record(z.string(), OutputFilesFlatSchema.catch(new Map()))
  .transform((record): Map<number, OutputFileInfo[]> => {
    const latest = pickLatestRunEntries(record, (m) => m.size === 0);
    return latest ?? new Map();
  });

export const OutputFilesDataSchema = z
  .union([OutputFilesFlatSchema, OutputFilesLegacySchema])
  .catch(new Map()) as z.ZodType<Map<number, OutputFileInfo[]>>;

// ============================================================================
// Missing outputs: { round: string[] } (new) or { runId: { round: … } } (legacy)
// ============================================================================

const MissingOutputsFlatSchema = z
  .record(z.string(), z.array(z.string()).catch([]))
  .transform(recordToRoundMap);

const MissingOutputsLegacySchema = z
  .record(z.string(), MissingOutputsFlatSchema.catch(new Map()))
  .transform((record): Map<number, string[]> => {
    const latest = pickLatestRunEntries(record, (m) => m.size === 0);
    return latest ?? new Map();
  });

export const MissingOutputsDataSchema = z
  .union([MissingOutputsFlatSchema, MissingOutputsLegacySchema])
  .catch(new Map()) as z.ZodType<Map<number, string[]>>;

// ============================================================================
// Usage stats
// ============================================================================

/** Coerces input to number, defaulting non-finite values to 0 */
const FiniteNumber = z.coerce
  .number()
  .transform((n) => (Number.isFinite(n) ? n : 0));

/** Parsing schema with safe number coercion. */
const TokenUsageStatsParsingBaseSchema = z.object({
  inputTokens: FiniteNumber,
  outputTokens: FiniteNumber,
  cost: FiniteNumber,
  cacheReadInputTokens: FiniteNumber.optional().prefault(0),
  cacheCreationInputTokens: FiniteNumber.optional().prefault(0),
});

export const TokenUsageStatsParsingSchema =
  TokenUsageStatsParsingBaseSchema.catch({
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  });

// Compile-time assertion: parsing schema output must be assignable to canonical type.
type _AssertSchemaCompatible =
  z.infer<typeof TokenUsageStatsParsingSchema> extends TokenUsageStats
    ? true
    : never;
void (true as _AssertSchemaCompatible);

// Runtime assertion: ensure all canonical keys are handled
const canonicalKeys = TokenUsageStatsSchema.keyof().options;
const parsingKeys = new Set(
  Object.keys(TokenUsageStatsParsingBaseSchema.shape),
);
const missingKeys = canonicalKeys.filter((k) => !parsingKeys.has(k));
if (missingKeys.length > 0) {
  throw new Error(
    `TokenUsageStatsParsingSchema missing keys from canonical schema: ${missingKeys.join(', ')}`,
  );
}

/** Checks if usage stats are all zeros (effectively empty) */
export function isEmptyUsage(usage: TokenUsageStats): boolean {
  return (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cost === 0 &&
    (usage.cacheReadInputTokens ?? 0) === 0 &&
    (usage.cacheCreationInputTokens ?? 0) === 0
  );
}

/**
 * Per-run usage map: { runId: TokenUsageStats } → Map<runId, stats>.
 * Used for both workflow (one entry per tab) and tool-use (multiple entries
 * via resume). Workflow consumers compute a single accumulated value.
 */
export const UsageDataSchema = z
  .record(z.string(), TokenUsageStatsParsingSchema)
  .transform((record): Map<string, TokenUsageStats> => {
    const map = new Map<string, TokenUsageStats>();
    for (const [runId, stats] of Object.entries(record)) {
      if (!isEmptyUsage(stats)) map.set(runId, stats);
    }
    return map;
  })
  .catch(new Map()) as z.ZodType<Map<string, TokenUsageStats>>;

/** Per-run usage record (write side). */
export type UsageStatsRecord = Record<string, TokenUsageStats>;

// ============================================================================
// Instruction
// ============================================================================

/** New flat shape: a single InstructionUpdate (or null). */
const InstructionFlatSchema = InstructionUpdateSchema.nullable();

/** Legacy: { runId: InstructionUpdate } → pick latest run's instruction. */
const InstructionLegacySchema = z
  .record(z.string(), InstructionUpdateSchema)
  .transform((record): InstructionUpdate | null => {
    return pickLatestRunEntries(record, () => false);
  });

export const InstructionRecordSchema = z
  .union([InstructionFlatSchema, InstructionLegacySchema])
  .nullable()
  .catch(null) as z.ZodType<InstructionUpdate | null>;

// ============================================================================
// Write-side types — shape contracts for data written to disk
// ============================================================================

export type OutputFilesRecord = Record<string, OutputFileInfo[]>;
export type MissingOutputsRecord = Record<string, string[]>;
