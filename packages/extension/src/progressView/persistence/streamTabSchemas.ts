/**
 * Zod schemas for stream-tab persistence.
 *
 * Single source of truth for all data shapes read from / written to disk
 * by StreamTabStore, OutputFilesManager, and UsageStatsManager.
 *
 * Legacy data (from before the one-run-per-tab refactor) was keyed by runId:
 *   - outputFiles.json / missingOutputs.json used `{ runId: { round: … } }`
 *   - usageStats.json used `{ runId: TokenUsageStats }` (still the stored shape)
 *
 * The preprocess helpers below detect the legacy nested shape and flatten
 * it to the new format by picking the most recent run (last-inserted key).
 */

import { z } from 'zod';

import { TaskStateSchema } from '@agent/core/TaskState';
import {
  CompileFailureSchema,
  OutputFileInfoSchema,
  TokenUsageStatsSchema,
  type CompileFailure,
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
// Legacy instructions: { runId: { text, timestamp?, ... } }
// ============================================================================

export const LegacyInstructionEntrySchema = z.looseObject({
  text: z.string(),
  timestamp: z.number().optional(),
});

export type LegacyInstructionEntry = z.infer<
  typeof LegacyInstructionEntrySchema
>;

export const LegacyInstructionsDataSchema = z
  .record(z.string(), LegacyInstructionEntrySchema)
  .catch({});

/**
 * Pick the legacy instruction that best matches the workflow run users most
 * recently viewed. Prefer `preferredRunId` when available; otherwise fall back
 * to the newest timestamp, breaking ties by later insertion order.
 */
export function selectPreferredLegacyInstruction(
  record: Record<string, LegacyInstructionEntry>,
  preferredRunId?: string | null,
): LegacyInstructionEntry | null {
  if (preferredRunId && record[preferredRunId]) {
    return record[preferredRunId];
  }

  let selected: LegacyInstructionEntry | null = null;
  for (const entry of Object.values(record)) {
    if (!selected) {
      selected = entry;
      continue;
    }

    const nextTimestamp = entry.timestamp ?? Number.NEGATIVE_INFINITY;
    const currentTimestamp = selected.timestamp ?? Number.NEGATIVE_INFINITY;
    if (nextTimestamp >= currentTimestamp) {
      selected = entry;
    }
  }

  return selected;
}

// ============================================================================
// Legacy detection + flattening
// ============================================================================

/**
 * Detects whether a record is the legacy nested shape
 * (`{ runId: { round: items[] } }`) rather than the flat shape
 * (`{ round: items[] }`).
 *
 * Flat records satisfy BOTH properties:
 *   - every top-level key parses as an integer (round number)
 *   - every top-level value is an array (the items list for that round)
 *
 * If either property fails on any entry, the record is treated as legacy.
 * This guards against a numeric-only runId sneaking through the key check
 * and against a legacy record whose inner maps happen to be arrays.
 */
export function isLegacyNested(raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.some(
    ([key, value]) => !/^-?\d+$/.test(key) || !Array.isArray(value),
  );
}

/**
 * Flatten a legacy nested record to a single run's round-keyed map.
 * Prefers the `preferredRunId` when that entry exists (legacy tabs persisted
 * `activeRunId` in meta.json to mark the selected run); otherwise falls back
 * to JS insertion order and picks the last-written run.
 */
export function flattenLegacyRuns(
  raw: Record<string, unknown>,
  preferredRunId?: string | null,
): Record<string, unknown> {
  if (preferredRunId) {
    const picked = raw[preferredRunId];
    if (picked && typeof picked === 'object' && !Array.isArray(picked)) {
      return picked as Record<string, unknown>;
    }
  }
  let latest: Record<string, unknown> | null = null;
  for (const value of Object.values(raw)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      latest = value as Record<string, unknown>;
    }
  }
  return latest ?? {};
}

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

// ============================================================================
// Output files: { round: OutputFileInfo[] }
// ============================================================================

function warnDroppedItem(
  kind: string,
  error: { issues: readonly { path: PropertyKey[]; message: string }[] },
): void {
  console.warn(
    `[streamTabSchemas] Dropping malformed ${kind} entry: ${error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')}`,
  );
}

const OutputFileListSchema = z
  .array(z.unknown())
  .transform((items) =>
    items.flatMap((item) => {
      const parsed = OutputFileInfoSchema.safeParse(item);
      if (parsed.success) return [parsed.data];
      warnDroppedItem('OutputFileInfo', parsed.error);
      return [];
    }),
  )
  .catch([]);

/**
 * Parses a flat round-keyed record to `Map<number, OutputFileInfo[]>`.
 * Legacy nested records (`{ runId: { round: items[] } }`) must be
 * pre-flattened by the caller (see `flattenLegacyRuns`) so the
 * activeRunId hint can be threaded in — the schema itself does not fall
 * back to insertion order.
 */
export const OutputFilesDataSchema = z
  .record(z.string(), OutputFileListSchema)
  .transform(recordToRoundMap)
  .catch(new Map()) as z.ZodType<Map<number, OutputFileInfo[]>>;

// ============================================================================
// Missing outputs: { round: string[] } (caller pre-flattens legacy input).
// ============================================================================

export const MissingOutputsDataSchema = z
  .record(z.string(), z.array(z.string()).catch([]))
  .transform(recordToRoundMap)
  .catch(new Map()) as z.ZodType<Map<number, string[]>>;

// ============================================================================
// Compile failures: { round: CompileFailure[] } (caller pre-flattens legacy input).
// ============================================================================

export const CompileFailuresDataSchema = z
  .record(z.string(), z.array(CompileFailureSchema).catch([]))
  .transform(recordToRoundMap)
  .catch(new Map()) as z.ZodType<Map<number, CompileFailure[]>>;

// ============================================================================
// Usage stats — per-run map kept (tool-use can resume → multiple runs).
// Workflow consumers collapse to a single value via sumUsageStats.
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
  cacheMissInputTokens: FiniteNumber.optional().prefault(0),
  cacheCreationInputTokens: FiniteNumber.optional().prefault(0),
});

export const TokenUsageStatsParsingSchema =
  TokenUsageStatsParsingBaseSchema.catch({
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    cacheReadInputTokens: 0,
    cacheMissInputTokens: 0,
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
    (usage.cacheMissInputTokens ?? 0) === 0 &&
    (usage.cacheCreationInputTokens ?? 0) === 0
  );
}

/**
 * Per-run usage map: { runId: TokenUsageStats } → Map<runId, stats>.
 * Used by both workflow and tool-use streams. Workflow has one entry per
 * run (= one entry per tab); tool-use can accumulate multiple via resume.
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

// ============================================================================
// Write-side types — shape contracts for data written to disk
// ============================================================================

export type OutputFilesRecord = Record<string, OutputFileInfo[]>;
export type MissingOutputsRecord = Record<string, string[]>;
export type CompileFailuresRecord = Record<string, CompileFailure[]>;
export type UsageStatsRecord = Record<string, TokenUsageStats>;
