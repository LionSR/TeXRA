/**
 * Host-agnostic parsing schemas for per-stream sidecar data on disk
 * (`streamData/{id}/{outputFiles,missingOutputs,compileFailures,usageStats}.json`).
 *
 * The CLI, extension, and desktop all read and write these files, so the
 * shared `StreamSnapshotStore` and the extension managers parse identical
 * on-disk shapes from this one definition. Only `@agent`-free schemas live
 * here.
 *
 * Usage remains keyed by runId because tool-use sessions can resume across
 * multiple executions.
 */

import { z } from 'zod';

import { ExecutionIdSchema } from './identifiers';
import { formatZodIssuesMessage } from './toolResult';
import {
  TokenUsageStatsSchema,
  isEmptyUsage,
  type TokenUsageStats,
} from './usage';

// ============================================================================
// Per-stream meta file (streamData/{id}/meta.json) — single source of truth
// ============================================================================

export const STREAM_TAB_META_SCHEMA_VERSION = 1;

/**
 * On-disk shape of `meta.json`. The stream sidecar carries a foreign key
 * (`executionId`) into `executions/{id}/` — identity and config live there,
 * never as a sidecar copy. Pre-FK sidecars carried a whole `runDescriptor`;
 * that retired shape is no longer read — the unknown key is stripped and the
 * sidecar simply has no FK.
 */
export const StreamTabMetaSchema = z.object({
  schemaVersion: z
    .literal(STREAM_TAB_META_SCHEMA_VERSION)
    .prefault(STREAM_TAB_META_SCHEMA_VERSION),
  parentStreamId: z.string().optional(),
  /** FK into `executions/{executionId}/` — the durable run authority. */
  executionId: ExecutionIdSchema.optional(),
});

export type StreamTabMeta = z.infer<typeof StreamTabMetaSchema>;

// ============================================================================
// Usage stats — per-run map kept (tool-use can resume → multiple runs).
// Workflow consumers collapse to a single value via sumUsageStats.
// ============================================================================

/** Coerces input to number, defaulting non-finite values to 0 */
const FiniteNumber = z.coerce
  .number()
  .transform((n) => (Number.isFinite(n) ? n : 0));

/**
 * Parsing schema with safe number coercion.
 *
 * Exported so callers that need to validate a single usage delta (e.g.
 * {@link StreamSnapshotStore.addUsage}) can `safeParse` it themselves and log
 * loudly on failure, instead of defaulting to zero. Never wrap this in
 * `.catch()` for persisted/cost data — see `parseUsageData`'s docs and #7464.
 */
export const TokenUsageStatsParsingBaseSchema = TokenUsageStatsSchema.extend({
  inputTokens: FiniteNumber,
  outputTokens: FiniteNumber,
  cost: FiniteNumber,
  cacheReadInputTokens: FiniteNumber.optional().prefault(0),
  cacheMissInputTokens: FiniteNumber.optional().prefault(0),
  cacheCreationInputTokens: FiniteNumber.optional().prefault(0),
  reasoningTokens: FiniteNumber.optional().prefault(0),
});

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
 * Failures are isolated PER RUN, so one malformed entry can't silently zero
 * every other run's cost data. A run whose value isn't a well-formed usage
 * object is logged loudly (not swallowed) and its raw value is returned in
 * `unparsedRuns` for the caller to preserve, rather than defaulted to zero
 * and dropped. Individual numeric fields inside an otherwise object-shaped
 * entry still coerce/zero via `TokenUsageStatsParsingBaseSchema`'s own
 * per-field handling.
 *
 * A top-level value that isn't a record at all (e.g. corrupted to an array
 * or a scalar) has no runId to key a preserved raw entry against, so it is
 * only logged loudly; recovering it would require guessing intent. See #7464.
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
      `[streamData] usageStats.json is not a per-run object (got ${rawKind}); ` +
        'ignoring for this read instead of silently zeroing usage.',
    );
    return { usage, unparsedRuns };
  }

  for (const [runId, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = TokenUsageStatsParsingBaseSchema.safeParse(value);
    if (!parsed.success) {
      console.warn(
        `[streamData] Preserving unparseable usage entry for run "${runId}" ` +
          `unchanged (not dropped): ${formatZodIssuesMessage(parsed.error.issues)}`,
      );
      unparsedRuns.set(runId, value);
      continue;
    }
    if (!isEmptyUsage(parsed.data)) usage.set(runId, parsed.data);
  }
  return { usage, unparsedRuns };
}
