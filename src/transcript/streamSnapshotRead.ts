/**
 * Pure disk → {@link StreamSnapshot} reading for `streamData/{id}/`.
 *
 * Split out of `StreamSnapshotStore` so the (stateless) read/assembly is
 * separate from the (stateful) accumulate/write side. Reads every sidecar file
 * ONCE into canonical (flat) Maps; `StreamSnapshotStore.load()` seeds its
 * in-memory accumulators from this directly, and persists any legacy-flattened
 * files once (see `legacyKeys`) so the conversion never re-runs.
 */

import { z } from 'zod';

import { KVStore } from '@common/storage/KVStore';
import * as logger from '@logger/logUtils';
import {
  CompileFailuresDataSchema,
  MissingOutputsDataSchema,
  OutputFilesDataSchema,
  PersistedWorkPlanSchema,
  StreamSnapshotSchema,
  StreamTabMetaSchema,
  UsageDataSchema,
  flattenLegacyRuns,
  isLegacyNested,
  type CompileFailure,
  type OutputFileInfo,
  type StreamSnapshot,
  type StreamTabId,
  type StreamTabMeta,
  type TokenUsageStats,
  type WorkPlanSnapshot,
} from '@shared/schemas';

import { STREAM_DATA_KEYS } from './streamDataPaths';

const CHANNEL = 'StreamSnapshotStore';

const EMPTY_WORK_PLAN: WorkPlanSnapshot = {
  todos: [],
  plan: null,
  planSummary: null,
};

/** Per-stream sidecar data read from disk, flattened to canonical (flat) form. */
export interface StreamData {
  meta: StreamTabMeta | undefined;
  outputFiles: Map<number, OutputFileInfo[]>;
  missingOutputs: Map<number, string[]>;
  compileFailures: Map<number, CompileFailure[]>;
  usage: Map<string, TokenUsageStats>;
  workPlan: WorkPlanSnapshot;
  /** Category keys whose on-disk file was legacy-nested (need a one-time flat rewrite). */
  legacyKeys: string[];
}

/** Map → string-keyed Record for JSON persistence / the snapshot's record fields. */
export function mapToRecord<K extends string | number, V>(
  map: Map<K, V>,
): Record<string, V> {
  return Object.fromEntries(Array.from(map, ([k, v]) => [String(k), v]));
}

/**
 * Treat corrupt/truncated JSON (crash mid-write) as a missing file — the next
 * write replaces it — but log it so it is not silently swallowed.
 */
async function tryRead(kv: KVStore, key: string): Promise<unknown | undefined> {
  try {
    return await kv.read(key);
  } catch (error) {
    if (error instanceof SyntaxError) {
      logger.warn(
        CHANNEL,
        `Discarding unreadable ${key}.json; treating as missing.`,
        { data: error },
      );
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
  const parsed = StreamTabMetaSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Read every per-stream sidecar file ONCE, flattening any legacy nested data. */
export async function readStreamData(kv: KVStore): Promise<StreamData> {
  const meta = await readMeta(kv);
  const activeRunId = meta?.activeRunId ?? undefined;
  const legacyKeys: string[] = [];

  const flatten = async <T extends Map<number, unknown[]>>(
    key: string,
    schema: z.ZodType<T>,
  ): Promise<T> => {
    const raw = await tryRead(kv, key);
    if (raw === undefined) return new Map() as T;
    const wasLegacy = isLegacyNested(raw);
    if (wasLegacy) legacyKeys.push(key);
    const parsed = schema.safeParse(
      wasLegacy ? flattenLegacyRuns(raw, activeRunId) : raw,
    );
    return parsed.success ? parsed.data : (new Map() as T);
  };

  const [outputFiles, missingOutputs, compileFailures] = await Promise.all([
    flatten(STREAM_DATA_KEYS.OUTPUT_FILES, OutputFilesDataSchema),
    flatten(STREAM_DATA_KEYS.MISSING_OUTPUTS, MissingOutputsDataSchema),
    flatten(STREAM_DATA_KEYS.COMPILE_FAILURES, CompileFailuresDataSchema),
  ]);

  const usageRaw = await tryRead(kv, STREAM_DATA_KEYS.USAGE_STATS);
  const usageParsed =
    usageRaw === undefined ? undefined : UsageDataSchema.safeParse(usageRaw);
  const usage = usageParsed?.success
    ? usageParsed.data
    : new Map<string, TokenUsageStats>();

  // PersistedWorkPlanSchema's per-field `.catch` degrades a corrupt-but-valid-
  // JSON workPlan.json gracefully instead of throwing and aborting the read.
  const workPlanRaw = await tryRead(kv, STREAM_DATA_KEYS.WORK_PLAN);
  const parsedWorkPlan = workPlanRaw
    ? PersistedWorkPlanSchema.safeParse(workPlanRaw)
    : undefined;
  const workPlan = parsedWorkPlan?.success ? parsedWorkPlan.data : EMPTY_WORK_PLAN;

  return {
    meta,
    outputFiles,
    missingOutputs,
    compileFailures,
    usage,
    workPlan,
    legacyKeys,
  };
}

/**
 * Build the durable display snapshot from {@link StreamData}. Liveness fields
 * stay at their defaults — callers layer log-derived + clamped-live state on top.
 */
export function assembleSnapshot(
  streamId: StreamTabId,
  data: StreamData,
): StreamSnapshot {
  return StreamSnapshotSchema.parse({
    streamId,
    todos: data.workPlan.todos,
    plan: data.workPlan.plan,
    planSummary: data.workPlan.planSummary,
    outputFilesByRound: mapToRecord(data.outputFiles),
    missingOutputsByRound: mapToRecord(data.missingOutputs),
    compileFailuresByRound: mapToRecord(data.compileFailures),
    runUsage: mapToRecord(data.usage),
    executionId: data.meta?.executionId,
    parentStreamId: data.meta?.parentStreamId,
    description: data.meta?.description,
  });
}
