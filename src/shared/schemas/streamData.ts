/**
 * Host-agnostic parsing schemas for per-stream sidecar data on disk
 * (`streamData/{id}/{outputFiles,missingOutputs,compileFailures,usageStats}.json`).
 *
 * Relocated out of the extension's `streamTabSchemas.ts` so the shared
 * `StreamSnapshotStore` (core) and the extension managers parse identical
 * on-disk shapes — the CLI, extension, and desktop all read/write the same
 * files. Only `@agent`-free schemas live here; `StreamTabMetaSchema` keeps its
 * `TaskState` dependency in the extension layer.
 *
 * Legacy data (from before the one-run-per-tab refactor) was keyed by runId:
 *   - outputFiles.json / missingOutputs.json used `{ runId: { round: … } }`
 *     (absorbed at the canonical parse entry — see
 *     `parsePersistedRoundIndexed` in `./roundIndexed`)
 *   - usageStats.json used `{ runId: TokenUsageStats }` (still the stored shape)
 */

import { z } from 'zod';

import {
  RUN_DESCRIPTOR_SCHEMA_VERSION,
  RunDescriptorSchema,
} from './runDescriptor';
import {
  TokenUsageStatsBaseSchema,
  UsageRouteSchema,
  emptyUsageStats,
  isEmptyUsage,
  type TokenUsageStats,
} from './usage';

// ============================================================================
// Per-stream meta file (streamData/{id}/meta.json) — single source of truth
// ============================================================================

/**
 * On-disk shape of `meta.json`. `taskState` is kept as `unknown` here so this
 * schema stays `@agent`-free and can live in `@shared/schemas`; consumers that
 * need the typed value parse it with `TaskStateSchema` (which depends on
 * `@agent`). This is THE definition — the core `StreamSnapshotStore` /
 * `streamSnapshotRead` import it directly, never their own copy.
 */
export const StreamTabMetaSchema = z.object({
  schemaVersion: z
    .literal(RUN_DESCRIPTOR_SCHEMA_VERSION)
    .prefault(RUN_DESCRIPTOR_SCHEMA_VERSION),
  /** Legacy field — no longer written, tolerated on read so we can skip it. */
  activeRunId: z.string().nullish(),
  parentStreamId: z.string().optional(),
  executionId: z.string().optional(),
  runDescriptor: RunDescriptorSchema.optional(),
  /** Legacy field — read-shimmed from pre-RunDescriptor snapshots only. */
  taskState: z.unknown().optional(),
  /** AI-generated session description, mirrored from ExecutionMeta. */
  description: z.string().optional(),
});

export type StreamTabMeta = z.infer<typeof StreamTabMetaSchema>;

// ============================================================================
// Legacy instructions: { runId: { text, timestamp?, ... } }
//
// Archival-only: tabs created before the one-run-per-tab refactor (#3061,
// 2026-04-19) may still have this on disk (as `legacyInstructions.json`, or
// the older `runInstructions.json` written before that refactor renamed the
// key). Current code never writes it; `StreamSnapshotStore.readLegacyInstruction`
// reads it once at load() so those tabs can backfill their original user
// message into the stream log. Retire alongside the other #3061-era shims
// tracked in `docs/proposals/architecture-checkpoints-2026.md` / `#6981`.
// ============================================================================

const LegacyInstructionEntrySchema = z.looseObject({
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
// Usage stats — per-run map kept (tool-use can resume → multiple runs).
// Workflow consumers collapse to a single value via sumUsageStats.
// ============================================================================

/** Coerces input to number, defaulting non-finite values to 0 */
const FiniteNumber = z.coerce
  .number()
  .transform((n) => (Number.isFinite(n) ? n : 0));

function isNumericUsageField(schema: z.ZodType): boolean {
  const inner = schema instanceof z.ZodOptional ? schema.unwrap() : schema;
  return inner instanceof z.ZodNumber;
}

const numericUsageParsingShape = Object.fromEntries(
  Object.entries(TokenUsageStatsBaseSchema.shape)
    .filter(([, schema]) => isNumericUsageField(schema))
    .map(([key, schema]) => [
      key,
      schema instanceof z.ZodOptional
        ? FiniteNumber.optional().prefault(0)
        : FiniteNumber,
    ]),
);

/** Parsing schema with safe number coercion. */
const TokenUsageStatsParsingBaseSchema = z
  .object({
    ...numericUsageParsingShape,
    viaChatGptSubscription: z.boolean().catch(false).prefault(false),
    usageRoute: UsageRouteSchema.optional().catch(undefined),
    // The numeric fields are derived from `TokenUsageStatsBaseSchema.shape` above;
    // TypeScript cannot recover the required keys through `Object.fromEntries`.
  })
  .transform(({ viaChatGptSubscription, ...usage }): TokenUsageStats => {
    const stats = usage as TokenUsageStats;
    const usageRoute =
      stats.usageRoute ??
      (viaChatGptSubscription === true ? 'chatgpt-subscription' : undefined);
    return usageRoute == null ? stats : { ...stats, usageRoute };
  }) as z.ZodType<TokenUsageStats>;

export const TokenUsageStatsParsingSchema =
  TokenUsageStatsParsingBaseSchema.catch(emptyUsageStats());

// Compile-time assertion: parsing schema output must be assignable to canonical type.
void (null as unknown as z.infer<
  typeof TokenUsageStatsParsingSchema
> satisfies TokenUsageStats);

export interface ParsedUsageData {
  /** Successfully parsed, non-empty per-run usage. */
  usage: Map<string, TokenUsageStats>;
  /**
   * Raw per-run values that failed to parse (e.g. a value that isn't an
   * object at all — a corrupted or unrecognized future shape), keyed by
   * runId and preserved byte-for-byte. `StreamSnapshotStore.writeUsage`
   * round-trips these back into `usageStats.json` unchanged instead of
   * dropping them, so a save can never permanently delete cost data current
   * code doesn't understand. See #7464.
   */
  unparsedRuns: Map<string, unknown>;
}

/**
 * Parses the persisted per-run usage-stats record (`usageStats.json`) into
 * `{ runId: TokenUsageStats }` → `Map<runId, stats>`. Used by both workflow
 * and tool-use streams. Workflow has one entry per run (= one entry per
 * tab); tool-use can accumulate multiple via resume.
 *
 * Failures are isolated PER RUN — via `safeParse` rather than the previous
 * `.catch(emptyUsageStats())` — so one malformed entry can't silently zero
 * every other run's cost data. A run whose value isn't a well-formed usage
 * object is logged loudly (not swallowed) and its raw value is returned in
 * `unparsedRuns` for the caller to preserve, rather than defaulted to zero
 * and dropped. Individual numeric fields inside an otherwise object-shaped
 * entry still coerce/zero via `TokenUsageStatsParsingBaseSchema`'s own
 * per-field handling — that salvage behavior is unrelated to this fix and
 * intentionally unchanged.
 *
 * A top-level value that isn't a record at all (e.g. corrupted to an array
 * or a scalar) has no runId to key a preserved raw entry against, so it is
 * only logged loudly; recovering it would require guessing intent. This is
 * an extreme, likely-tampered edge case — the realistic failure mode this
 * fixes is a single corrupted run entry within an otherwise valid record.
 */
export function parseUsageData(raw: unknown): ParsedUsageData {
  const usage = new Map<string, TokenUsageStats>();
  const unparsedRuns = new Map<string, unknown>();
  if (raw === undefined) return { usage, unparsedRuns };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    let rawKind: string;
    if (raw === null) {
      rawKind = 'null';
    } else if (Array.isArray(raw)) {
      rawKind = 'array';
    } else {
      rawKind = typeof raw;
    }
    console.warn(
      `[streamData] usageStats.json is not a per-run object (got ` +
        `${rawKind}); ` +
        'ignoring for this read instead of silently zeroing usage.',
    );
    return { usage, unparsedRuns };
  }

  for (const [runId, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = TokenUsageStatsParsingBaseSchema.safeParse(value);
    if (!parsed.success) {
      console.warn(
        `[streamData] Preserving unparseable usage entry for run "${runId}" ` +
          `unchanged (not dropped): ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; ')}`,
      );
      unparsedRuns.set(runId, value);
      continue;
    }
    if (!isEmptyUsage(parsed.data)) usage.set(runId, parsed.data);
  }
  return { usage, unparsedRuns };
}
