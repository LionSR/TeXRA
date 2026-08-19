/**
 * Pure disk → {@link StreamSnapshot} reading for `streamData/{id}/`.
 *
 * Split out of `StreamSnapshotStore` so the (stateless) read/assembly is
 * separate from the (stateful) accumulate/write side. Reads every sidecar file
 * ONCE into canonical round-indexed records; `StreamSnapshotStore.load()`
 * seeds its in-memory accumulators from this directly.
 */

import { z } from 'zod';

import { KVStore } from '@common/storage/KVStore';
import { createLog } from '@logger/logUtils';
import {
  CompileFailureSchema,
  OutputFileInfoSchema,
  parsePersistedRoundIndexed,
  parseUsageData,
  PersistedWorkPlanSchema,
  STREAM_SNAPSHOT_SCHEMA_VERSION,
  StreamSnapshotSchema,
  StreamTabMetaSchema,
  WorkPlanSnapshotShape,
  type CompileFailure,
  type OutputFileInfo,
  type ParsedUsageData,
  type RoundIndexed,
  type StreamSnapshot,
  type StreamTabId,
  type StreamTabMeta,
  type TodoItem,
  type TokenUsageStats,
  type WorkPlanSnapshot,
} from '@shared/schemas';
import { isObject, mapToRecord } from '@utils/core';

import { STREAM_DATA_KEYS } from './streamDataPaths';

const log = createLog('StreamSnapshotStore');

/** The canonical empty work plan (no todos, no plan). Single source for the
 *  "no durable plan yet" value, reused by the store's in-memory default. */
export const EMPTY_WORK_PLAN = Object.freeze({
  todos: Object.freeze([]) as unknown as TodoItem[],
  plan: null,
  planSummary: null,
}) as WorkPlanSnapshot;

/** Per-stream sidecar data read from disk, flattened to canonical (flat) form. */
export interface StreamData {
  meta: StreamTabMeta | undefined;
  outputFiles: RoundIndexed<OutputFileInfo>;
  missingOutputs: RoundIndexed<string>;
  compileFailures: RoundIndexed<CompileFailure>;
  usage: Map<string, TokenUsageStats>;
  /**
   * Raw per-run usage values that failed to parse, keyed by runId and
   * preserved verbatim (see {@link parseUsageData}). `StreamSnapshotStore`
   * round-trips these back into `usageStats.json` on the next write instead
   * of a lossy read silently deleting them (#7464).
   */
  usageUnparsed: Map<string, unknown>;
  workPlan: WorkPlanSnapshot;
}

/**
 * Fresh empty {@link StreamData} for a stream whose sidecar directory was
 * verified absent. Fresh containers per call: the store's accumulators mutate
 * the round-indexed records in place.
 */
export function emptyStreamData(): StreamData {
  return {
    meta: undefined,
    outputFiles: {},
    missingOutputs: {},
    compileFailures: {},
    usage: new Map(),
    usageUnparsed: new Map(),
    workPlan: EMPTY_WORK_PLAN,
  };
}

/**
 * Treat corrupt/truncated JSON (crash mid-write) as a missing file — the next
 * write replaces it — but log it so it is not silently swallowed. I/O errors
 * propagate: an unreadable-but-present sidecar must fail the read so seeding
 * keeps the record's `diskState` unknown instead of marking an empty base
 * `loaded` and letting a later mutation persist over the real on-disk data.
 */
async function tryRead(kv: KVStore, key: string): Promise<unknown | undefined> {
  try {
    return await kv.read(key);
  } catch (error) {
    if (error instanceof SyntaxError) {
      log.warn(`Discarding unreadable ${key}.json; treating as missing.`, {
        data: error,
      });
      return undefined;
    }
    throw error;
  }
}

export async function readMeta(
  kv: KVStore,
): Promise<StreamTabMeta | undefined> {
  const raw = await tryRead(kv, STREAM_DATA_KEYS.META);
  if (raw === undefined) return undefined;
  return parseStreamMeta(raw);
}

/**
 * Ownership reads need to distinguish any present-but-invalid metadata from a
 * genuinely absent `meta.json`. `readMeta` intentionally downgrades truncated
 * or schema-invalid JSON so a full seed can recover; this strict variant lets
 * the one-field ownership read propagate both JSON `SyntaxError` and
 * schema-invalid present metadata, so callers can skip or report the damaged
 * stream instead of treating it as a legacy record with no FK.
 */
export async function readMetaForOwnership(
  kv: KVStore,
): Promise<StreamTabMeta | undefined> {
  const raw = await kv.read(STREAM_DATA_KEYS.META);
  if (raw === undefined) return undefined;
  const parsed = StreamTabMetaSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn('Discarding unreadable persisted stream metadata for ownership.', {
      data: parsed.error,
    });
    throw new Error('Invalid persisted stream metadata ownership');
  }
  return parsed.data;
}

function parseStreamMeta(raw: unknown): StreamTabMeta | undefined {
  const parsed = StreamTabMetaSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Field-level tolerance: a malformed execution FK must drop only the bad
  // pointer, not the whole meta — discarding everything would sever
  // `parentStreamId` and orphan the tab.
  if (isObject(raw)) {
    const { executionId: _executionId, ...rest } = raw;
    const retried = StreamTabMetaSchema.safeParse(rest);
    if (retried.success) {
      log.warn(
        'Dropping malformed execution FK from persisted stream metadata; ' +
          'keeping the remaining fields.',
        { data: parsed.error },
      );
      return retried.data;
    }
  }
  log.warn('Discarding unreadable persisted stream metadata.', {
    data: parsed.error,
  });
  return undefined;
}

/**
 * Read `workPlan.json`. A file written by a NEWER `schemaVersion` is IGNORED
 * (returns empty) rather than coerced, so we never consume a future shape's
 * fields as v1 — this is the single forward-compat gate. Within a known
 * version, each field is parsed independently so a malformed value cannot
 * erase valid siblings on the next whole-file write. Every recovery logs a
 * warning; a structurally unreadable file degrades to an empty plan loudly,
 * matching {@link assembleSnapshot}.
 */
function readPersistedWorkPlan(raw: unknown): WorkPlanSnapshot {
  if (!raw) return EMPTY_WORK_PLAN;
  if (!isObject(raw)) {
    log.warn('Discarding unreadable persisted work plan; using empty.', {
      data: raw,
    });
    return EMPTY_WORK_PLAN;
  }
  const version = raw.schemaVersion;
  if (typeof version === 'number' && version > STREAM_SNAPSHOT_SCHEMA_VERSION) {
    return EMPTY_WORK_PLAN;
  }
  if (version !== undefined && version !== STREAM_SNAPSHOT_SCHEMA_VERSION) {
    log.warn(
      'Discarding corrupted "schemaVersion" in persisted work plan; using current.',
      { data: version },
    );
  }
  const readField = <T>(
    field: keyof typeof WorkPlanSnapshotShape,
    schema: z.ZodType<T>,
    fallback: T,
  ): T => {
    if (raw[field] === undefined) return fallback;
    const parsed = schema.safeParse(raw[field]);
    if (parsed.success) return parsed.data;
    log.warn(
      `Discarding corrupted "${field}" in persisted work plan; using default.`,
      { data: parsed.error },
    );
    return fallback;
  };
  return PersistedWorkPlanSchema.parse({
    schemaVersion: STREAM_SNAPSHOT_SCHEMA_VERSION,
    todos: readField('todos', WorkPlanSnapshotShape.todos, [] as TodoItem[]),
    plan: readField('plan', WorkPlanSnapshotShape.plan, null),
    planSummary: readField(
      'planSummary',
      WorkPlanSnapshotShape.planSummary,
      null,
    ),
  });
}

/** Read every per-stream sidecar file once. */
export async function readStreamData(kv: KVStore): Promise<StreamData> {
  const meta = await readMeta(kv);

  const readRoundIndexed = async <T>(
    key: string,
    itemSchema: z.ZodType<T>,
  ): Promise<RoundIndexed<T>> =>
    parsePersistedRoundIndexed(key, await tryRead(kv, key), itemSchema);

  const [outputFiles, missingOutputs, compileFailures] = await Promise.all([
    readRoundIndexed(STREAM_DATA_KEYS.OUTPUT_FILES, OutputFileInfoSchema),
    readRoundIndexed(STREAM_DATA_KEYS.MISSING_OUTPUTS, z.string()),
    readRoundIndexed(STREAM_DATA_KEYS.COMPILE_FAILURES, CompileFailureSchema),
  ]);

  const usageRaw = await tryRead(kv, STREAM_DATA_KEYS.USAGE_STATS);
  const { usage, unparsedRuns: usageUnparsed } = parseUsageData(usageRaw);

  const workPlan = readPersistedWorkPlan(
    await tryRead(kv, STREAM_DATA_KEYS.WORK_PLAN),
  );

  return {
    meta,
    outputFiles,
    missingOutputs,
    compileFailures,
    usage,
    usageUnparsed,
    workPlan,
  };
}

/**
 * Read only the per-stream usage sidecar for usage-only hydration paths.
 *
 * Unlike the tolerant full-stream read, this path must never turn a
 * corrupt-present `usageStats.json` into an authoritative zero map: genuine
 * I/O errors and JSON `SyntaxError` propagate, and a present non-object value
 * is rejected instead of being silently treated as empty.
 */
export async function readUsageData(kv: KVStore): Promise<ParsedUsageData> {
  const raw = await kv.read(STREAM_DATA_KEYS.USAGE_STATS);
  if (raw === undefined) return parseUsageData(undefined);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid persisted usageStats.json');
  }
  return parseUsageData(raw);
}

/**
 * Build the durable display snapshot from {@link StreamData}. Liveness fields
 * stay at their defaults — callers layer log-derived + clamped-live state on top.
 */
export function assembleSnapshot(
  streamId: StreamTabId,
  data: StreamData,
): StreamSnapshot {
  try {
    return StreamSnapshotSchema.parse({
      streamId,
      todos: data.workPlan.todos,
      plan: data.workPlan.plan,
      planSummary: data.workPlan.planSummary,
      outputFilesByRound: data.outputFiles,
      missingOutputsByRound: data.missingOutputs,
      compileFailuresByRound: data.compileFailures,
      runUsage: mapToRecord(data.usage),
      executionId: data.meta?.executionId,
      parentStreamId: data.meta?.parentStreamId,
    });
  } catch (error) {
    // Defense-in-depth for the unwrapped CLI resume path (`await store.read`):
    // an unexpected on-disk shape degrades to an empty-but-valid snapshot,
    // logged so it stays diagnosable, rather than aborting hydration.
    log.warn(
      `Could not assemble snapshot for stream ${streamId}; using empty.`,
      { data: error },
    );
    return StreamSnapshotSchema.parse({ streamId });
  }
}
