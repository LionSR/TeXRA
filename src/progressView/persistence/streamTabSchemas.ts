/**
 * Zod schemas for stream-tab data deserialization.
 *
 * These schemas parse disk-backed JSON records into typed Map structures
 * used by OutputFilesManager, UsageStatsManager, and StreamTabStore.
 */

import { z } from 'zod';

import {
  OutputFileInfoSchema,
  TokenUsageStatsSchema,
  type OutputFileInfo,
  type TokenUsageStats,
} from '@shared/schemas';
import { isPlainObject } from '@shared/utils/string';

import { RoundKeySchema, createRoundMapSchema } from './schemaUtils';

// ============================================================================
// Output files
// ============================================================================

/** Schema for missing output paths (string arrays per round) */
export const MissingOutputRoundMapSchema = createRoundMapSchema(z.string());

/**
 * Schema for output files round map (filters invalid entries during parsing).
 * Parses { roundNum: OutputFileInfo[] } → Map<number, OutputFileInfo[]>
 */
export const OutputFilesRoundMapSchema = z
  .record(z.string(), z.array(z.unknown()).catch([]))
  .transform((record): Map<number, OutputFileInfo[]> => {
    const map = new Map<number, OutputFileInfo[]>();
    for (const [key, items] of Object.entries(record)) {
      const round = RoundKeySchema.safeParse(key);
      if (!round.success) continue;
      const parsed = items
        .map((item) => OutputFileInfoSchema.safeParse(item))
        .filter(
          (result): result is { success: true; data: OutputFileInfo } =>
            result.success,
        )
        .map((result) => result.data);
      if (parsed.length > 0) {
        map.set(round.data, parsed);
      }
    }
    return map;
  });

/**
 * Schema for output files run map.
 * Parses { runId: { roundNum: OutputFileInfo[] } } → Map<string, Map<number, OutputFileInfo[]>>
 */
export const OutputFilesDataSchema = z
  .unknown()
  .transform((data): Map<string, Map<number, OutputFileInfo[]>> => {
    if (!isPlainObject(data)) return new Map();

    const runMap = new Map<string, Map<number, OutputFileInfo[]>>();
    for (const [runId, value] of Object.entries(data)) {
      if (!isPlainObject(value)) continue;
      const result = OutputFilesRoundMapSchema.safeParse(value);
      if (result.success && result.data.size > 0) {
        runMap.set(runId, result.data);
      }
    }
    return runMap;
  }) as z.ZodType<Map<string, Map<number, OutputFileInfo[]>>>;

/**
 * Schema for missing outputs run map.
 * Parses { runId: { roundNum: string[] } } → Map<string, Map<number, string[]>>
 */
export const MissingOutputsDataSchema = z
  .unknown()
  .transform((data): Map<string, Map<number, string[]>> => {
    if (!isPlainObject(data)) return new Map();

    const runMap = new Map<string, Map<number, string[]>>();
    for (const [runId, value] of Object.entries(data)) {
      if (!isPlainObject(value)) continue;
      const result = MissingOutputRoundMapSchema.safeParse(value);
      if (result.success && result.data.size > 0) {
        runMap.set(runId, result.data);
      }
    }
    return runMap;
  }) as z.ZodType<Map<string, Map<number, string[]>>>;

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
 * Schema for run usage map format: { runId: TokenUsageStats }
 * Handles both new format (per-run object) and legacy single-value.
 */
export const UsageDataSchema = z.unknown().transform(
  (data): Map<string, TokenUsageStats> => {
    if (!isPlainObject(data)) return new Map();

    // Try new format first (per backward-compatibility guidance: new format first)
    const runMap = new Map<string, TokenUsageStats>();
    for (const [runId, value] of Object.entries(data)) {
      if (!isPlainObject(value)) continue;
      const result = TokenUsageStatsParsingSchema.safeParse(value);
      if (result.success && !isEmptyUsage(result.data)) {
        runMap.set(runId, result.data);
      }
    }
    if (runMap.size > 0) return runMap;

    // Fall back to legacy single-value format
    const legacyResult = TokenUsageStatsParsingSchema.safeParse(data);
    if (legacyResult.success && !isEmptyUsage(legacyResult.data)) {
      return new Map([['default', legacyResult.data]]);
    }

    return runMap;
  },
) as z.ZodType<Map<string, TokenUsageStats>>;
