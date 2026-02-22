/**
 * Zod schemas for stream-tab data deserialization.
 *
 * These schemas parse disk-backed JSON records into typed Map structures
 * used by OutputFilesManager, UsageStatsManager, and StreamTabStore.
 *
 * Design: Zod handles structural parsing (records, arrays, coercion).
 * Transforms only convert Record→Map at the boundary. No manual safeParse loops.
 */

import { z } from 'zod';

import {
  OutputFileInfoSchema,
  TokenUsageStatsSchema,
  type OutputFileInfo,
  type TokenUsageStats,
} from '@shared/schemas';

// ============================================================================
// Shared: round key coercion
// ============================================================================

/** Coerces and validates integer round keys from string record keys. */
export const RoundKeySchema = z.coerce.number().int();

// ============================================================================
// Output files
// ============================================================================

/**
 * Round map for output files: { roundNum: OutputFileInfo[] } → Map<number, OutputFileInfo[]>
 *
 * Per-item .catch(null) + .filter ensures one corrupt item doesn't drop the entire round.
 */
export const OutputFilesRoundMapSchema = z
  .record(
    z.string(),
    z.array(OutputFileInfoSchema.catch(null as unknown as OutputFileInfo))
      .transform((items) => items.filter((item): item is OutputFileInfo => item !== null))
      .catch([]),
  )
  .transform((record): Map<number, OutputFileInfo[]> => {
    const map = new Map<number, OutputFileInfo[]>();
    for (const [key, items] of Object.entries(record)) {
      const round = RoundKeySchema.safeParse(key);
      if (round.success && items.length > 0) {
        map.set(round.data, items);
      }
    }
    return map;
  });

/**
 * Run map for output files: { runId: roundMap } → Map<string, Map<number, OutputFileInfo[]>>
 */
export const OutputFilesDataSchema = z
  .record(z.string(), OutputFilesRoundMapSchema.catch(new Map()))
  .transform((record) => {
    const map = new Map<string, Map<number, OutputFileInfo[]>>();
    for (const [runId, rounds] of Object.entries(record)) {
      if (rounds.size > 0) map.set(runId, rounds);
    }
    return map;
  })
  .catch(new Map()) as z.ZodType<Map<string, Map<number, OutputFileInfo[]>>>;

/**
 * Round map for missing outputs: { roundNum: string[] } → Map<number, string[]>
 */
const MissingOutputsRoundMapSchema = z
  .record(z.string(), z.array(z.string()).catch([]))
  .transform((record): Map<number, string[]> => {
    const map = new Map<number, string[]>();
    for (const [key, items] of Object.entries(record)) {
      const round = RoundKeySchema.safeParse(key);
      if (round.success && items.length > 0) {
        map.set(round.data, items);
      }
    }
    return map;
  });

/**
 * Run map for missing outputs: { runId: roundMap } → Map<string, Map<number, string[]>>
 */
export const MissingOutputsDataSchema = z
  .record(z.string(), MissingOutputsRoundMapSchema.catch(new Map()))
  .transform((record) => {
    const map = new Map<string, Map<number, string[]>>();
    for (const [runId, rounds] of Object.entries(record)) {
      if (rounds.size > 0) map.set(runId, rounds);
    }
    return map;
  })
  .catch(new Map()) as z.ZodType<Map<string, Map<number, string[]>>>;

// ============================================================================
// Usage stats
// ============================================================================

/** Coerces input to number, defaulting non-finite values to 0 */
const FiniteNumber = z.coerce
  .number()
  .transform((n) => (Number.isFinite(n) ? n : 0));

/**
 * Schema for parsing TokenUsageStats with safe number coercion.
 */
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
 * Run usage map: { runId: TokenUsageStats } → Map<string, TokenUsageStats>
 *
 * Legacy single-value format (bare stats object without run wrapper) is handled
 * during workspace-state migration, not here. Data on disk is always new format.
 */
export const UsageDataSchema = z
  .record(z.string(), TokenUsageStatsParsingSchema)
  .transform((record) => {
    const map = new Map<string, TokenUsageStats>();
    for (const [runId, stats] of Object.entries(record)) {
      if (!isEmptyUsage(stats)) map.set(runId, stats);
    }
    return map;
  })
  .catch(new Map()) as z.ZodType<Map<string, TokenUsageStats>>;
