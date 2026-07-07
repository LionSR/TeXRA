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
  ExecutionIdSchema,
  LegacyInstructionsDataSchema,
  MissingOutputsDataSchema,
  OutputFilesDataSchema,
  parseUsageData,
  PersistedWorkPlanSchema,
  STREAM_SNAPSHOT_SCHEMA_VERSION,
  StreamSnapshotSchema,
  StreamTabMetaSchema,
  flattenLegacyRuns,
  isLegacyNested,
  selectPreferredLegacyInstruction,
  type CompileFailure,
  type LegacyInstructionEntry,
  type OutputFileInfo,
  type StreamSnapshot,
  type StreamTabId,
  type StreamTabMeta,
  type TodoItem,
  type TokenUsageStats,
  type WorkPlanSnapshot,
} from '@shared/schemas';
import { mapToRecord } from '@shared/progressView/backend/persistence/serializationUtils';
import { isObject } from '@utils/core';

import { STREAM_DATA_KEYS } from './streamDataPaths';

const CHANNEL = 'StreamSnapshotStore';

/** The canonical empty work plan (no todos, no plan). Single source for the
 *  "no durable plan yet" value, reused by the store's in-memory default. */
const EMPTY_TODOS = Object.freeze([]) as unknown as TodoItem[];
export const EMPTY_WORK_PLAN = Object.freeze({
  todos: EMPTY_TODOS,
  plan: null,
  planSummary: null,
}) as WorkPlanSnapshot;

/** Per-stream sidecar data read from disk, flattened to canonical (flat) form. */
export interface StreamData {
  meta: StreamTabMeta | undefined;
  outputFiles: Map<number, OutputFileInfo[]>;
  missingOutputs: Map<number, string[]>;
  compileFailures: Map<number, CompileFailure[]>;
  usage: Map<string, TokenUsageStats>;
  /**
   * Raw per-run usage values that failed to parse, keyed by runId and
   * preserved verbatim (see {@link parseUsageData}). `StreamSnapshotStore`
   * round-trips these back into `usageStats.json` on the next write instead
   * of a lossy read silently deleting them (#7464).
   */
  usageUnparsed: Map<string, unknown>;
  workPlan: WorkPlanSnapshot;
  /** Category keys whose on-disk file was legacy-nested (need a one-time flat rewrite). */
  legacyKeys: string[];
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
  if (!parsed.success) return undefined;
  // Validate the executionId VALUE at this single disk-read entry: a malformed
  // or legacy id degrades to absent (taskState/description still survive) so
  // every downstream consumer can trust it without re-validating — and the
  // strict ExecutionIdSchema in assembleSnapshot can never throw on resume.
  const meta = parsed.data;
  if (
    meta.executionId !== undefined &&
    !ExecutionIdSchema.safeParse(meta.executionId).success
  ) {
    return { ...meta, executionId: undefined };
  }
  return meta;
}

/**
 * Read the archived legacy per-run instruction, if any, and pick the run
 * users most likely expect to see. Read-only fallback for workflow tabs
 * created before the one-run-per-tab refactor (#3061, 2026-04-19): prefers
 * the canonical `legacyInstructions.json`, falling back to the older
 * `runInstructions.json` key from before that refactor renamed the archival
 * file (same record shape, so no on-disk migration is needed to read it).
 * `meta.activeRunId` (also legacy, tolerated on read) picks the run that was
 * active when the tab was last viewed; otherwise the newest entry wins.
 */
export async function readLegacyInstruction(
  kv: KVStore,
  meta: StreamTabMeta | undefined,
): Promise<LegacyInstructionEntry | null> {
  const raw =
    (await tryRead(kv, STREAM_DATA_KEYS.LEGACY_INSTRUCTIONS)) ??
    (await tryRead(kv, STREAM_DATA_KEYS.LEGACY_RUN_INSTRUCTIONS));
  if (raw === undefined) return null;

  const result = LegacyInstructionsDataSchema.safeParse(raw);
  if (!result.success || Object.keys(result.data).length === 0) return null;

  return selectPreferredLegacyInstruction(result.data, meta?.activeRunId);
}

/**
 * Read `workPlan.json`. A file written by a NEWER `schemaVersion` is IGNORED
 * (returns empty) rather than coerced, so we never consume a future shape's
 * fields as v1 — this is the single forward-compat gate. Within a known
 * version, `PersistedWorkPlanSchema`'s per-field `.catch` keeps one corrupt
 * value from nuking the rest instead of throwing and aborting the read.
 */
function readPersistedWorkPlan(raw: unknown): WorkPlanSnapshot {
  if (!raw) return EMPTY_WORK_PLAN;
  const version =
    isObject(raw) && typeof raw.schemaVersion === 'number'
      ? raw.schemaVersion
      : STREAM_SNAPSHOT_SCHEMA_VERSION;
  if (version > STREAM_SNAPSHOT_SCHEMA_VERSION) return EMPTY_WORK_PLAN;
  return PersistedWorkPlanSchema.catch({
    schemaVersion: STREAM_SNAPSHOT_SCHEMA_VERSION,
    ...EMPTY_WORK_PLAN,
  }).parse(raw);
}

/** Read every per-stream sidecar file ONCE, flattening any legacy nested data. */
export async function readStreamData(kv: KVStore): Promise<StreamData> {
  const meta = await readMeta(kv);
  const activeRunId = meta?.activeRunId ?? undefined;
  const legacyKeys: string[] = [];

  const flatten = async <T extends Map<number, unknown[]>>(
    key: string,
    schema: z.ZodType<T>,
    fallback: () => T,
  ): Promise<T> => {
    const raw = await tryRead(kv, key);
    if (raw === undefined) return fallback();
    const wasLegacy = isLegacyNested(raw);
    if (wasLegacy) legacyKeys.push(key);
    return (
      schema
        .nullable()
        .catch(null)
        .parse(wasLegacy ? flattenLegacyRuns(raw, activeRunId) : raw) ??
      fallback()
    );
  };

  const [outputFiles, missingOutputs, compileFailures] = await Promise.all([
    flatten(
      STREAM_DATA_KEYS.OUTPUT_FILES,
      OutputFilesDataSchema,
      () => new Map<number, OutputFileInfo[]>(),
    ),
    flatten(
      STREAM_DATA_KEYS.MISSING_OUTPUTS,
      MissingOutputsDataSchema,
      () => new Map<number, string[]>(),
    ),
    flatten(
      STREAM_DATA_KEYS.COMPILE_FAILURES,
      CompileFailuresDataSchema,
      () => new Map<number, CompileFailure[]>(),
    ),
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
  try {
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
  } catch (error) {
    // Defense-in-depth for the unwrapped CLI resume path (`await store.read`):
    // an unexpected on-disk shape degrades to an empty-but-valid snapshot,
    // logged so it stays diagnosable, rather than aborting hydration.
    logger.warn(
      CHANNEL,
      `Could not assemble snapshot for stream ${streamId}; using empty.`,
      { data: error },
    );
    return StreamSnapshotSchema.parse({ streamId });
  }
}
