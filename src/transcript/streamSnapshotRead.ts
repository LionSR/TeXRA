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
 * version, `PersistedWorkPlanSchema`'s per-field `.catch` keeps one corrupt
 * value from nuking the rest, but `.catch` itself is silent — so each field is
 * re-checked here against its raw (non-`.catch`) shape to log which one, if
 * any, actually got defaulted. Without this, a corrupted field is silently
 * dropped on this read and then permanently baked over the real on-disk value
 * by the next unrelated write (`writeWorkPlan` rewrites all three fields
 * together), with no diagnostic ever produced — the same silent-data-loss
 * trap `parseUsageData` (`@shared/schemas/streamData`, #7464) was built to
 * avoid for `usageStats.json`. A structurally unreadable file (a non-object
 * shape that survives the `!raw` guard) degrades to an empty plan LOUDLY —
 * warned and diagnosable — rather than via a silent whole-object `.catch`
 * default, matching the read-side degradation handling in
 * {@link assembleSnapshot}.
 */
function readPersistedWorkPlan(raw: unknown): WorkPlanSnapshot {
  if (!raw) return EMPTY_WORK_PLAN;
  const version =
    isObject(raw) && typeof raw.schemaVersion === 'number'
      ? raw.schemaVersion
      : STREAM_SNAPSHOT_SCHEMA_VERSION;
  if (version > STREAM_SNAPSHOT_SCHEMA_VERSION) return EMPTY_WORK_PLAN;
  const result = PersistedWorkPlanSchema.safeParse(raw);
  if (!result.success) {
    log.warn('Discarding unreadable persisted work plan; using empty.', {
      data: result.error,
    });
    return EMPTY_WORK_PLAN;
  }
  if (isObject(raw)) {
    for (const field of Object.keys(WorkPlanSnapshotShape) as Array<
      keyof typeof WorkPlanSnapshotShape
    >) {
      // A field that was never written (older file, or the key is simply
      // absent) is not corruption — only warn when a present value fails to
      // validate against its raw (non-`.catch`) shape.
      if (raw[field] === undefined) continue;
      const fieldResult = WorkPlanSnapshotShape[field].safeParse(raw[field]);
      if (!fieldResult.success) {
        log.warn(
          `Discarding corrupted "${field}" in persisted work plan; using default.`,
          { data: fieldResult.error },
        );
      }
    }
  }
  return result.data;
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
