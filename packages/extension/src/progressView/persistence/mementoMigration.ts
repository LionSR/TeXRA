/**
 * One-time migration from VS Code workspace state (memento) to disk-backed
 * StreamTabStore. This module can be deleted once all users have migrated.
 */

import type { AgentTrace } from '@agent/trace';
import { TaskStateSchema, type TaskState } from '@agent/core/TaskState';
import { WorkspaceStateKey } from '@common/state';
import { normalizeRunId } from '@common/constants/runIds';
import {
  StorageRecordSchema,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';
import { getStreamTabStore, mapStreamTabStorage } from './StreamTabStore';
import type {
  StreamTabMeta,
  OutputFilesRecord,
  MissingOutputsRecord,
} from './streamTabSchemas';
import type { MementoStorage } from './PersistentMapManager';

/**
 * Check if we need one-time migration from workspace state to disk.
 * Returns true if workspace state has data but disk has no stream data.
 */
export async function needsMigrationFromMemento(
  storage: MementoStorage,
  _streamIds: StreamTabId[],
): Promise<boolean> {
  // Check if memento has any of the legacy keys with data.
  // We intentionally do NOT short-circuit based on disk state: a partial
  // migration (e.g. crash) could leave some streams on disk while the memento
  // still holds data for un-migrated ones. Since migrateFromMemento() clears
  // memento keys on success, presence of memento data is the reliable signal.
  const legacyKeys = [
    WorkspaceStateKey.TASK_STATES,
    WorkspaceStateKey.OUTPUT_FILES,
    WorkspaceStateKey.USAGE_STATS,
    WorkspaceStateKey.EXECUTION_IDS,
    WorkspaceStateKey.ACTIVE_RUN_IDS,
    WorkspaceStateKey.PARENT_STREAM_IDS,
    WorkspaceStateKey.RUN_INSTRUCTIONS,
    WorkspaceStateKey.MISSING_OUTPUTS,
  ] as const;

  return legacyKeys.some((key) => {
    const raw = storage.get(key);
    return raw && typeof raw === 'object' && Object.keys(raw).length > 0;
  });
}

/**
 * One-time migration from workspace state (VS Code memento) to disk-backed storage.
 * Migrates all per-stream data to StreamTabStore, then clears the legacy keys.
 */
export async function migrateFromMemento(
  storage: MementoStorage,
  streamLogKeys: StreamTabId[],
  logger: AgentTrace,
): Promise<void> {
  logger.info(
    '[Migration] Starting one-time migration from workspace state to disk',
  );

  // Load all legacy data from memento
  const taskStatesRaw = loadRecord(storage, WorkspaceStateKey.TASK_STATES);
  const executionIdsRaw = loadRecord(storage, WorkspaceStateKey.EXECUTION_IDS);
  const activeRunIdsRaw = loadRecord(storage, WorkspaceStateKey.ACTIVE_RUN_IDS);
  const parentStreamIdsRaw = loadRecord(
    storage,
    WorkspaceStateKey.PARENT_STREAM_IDS,
  );
  const runInstructionsRaw = loadRecord(
    storage,
    WorkspaceStateKey.RUN_INSTRUCTIONS,
  );
  const outputFilesRaw = loadRecord(storage, WorkspaceStateKey.OUTPUT_FILES);
  const missingOutputsRaw = loadRecord(
    storage,
    WorkspaceStateKey.MISSING_OUTPUTS,
  );
  const usageStatsRaw = loadRecord(storage, WorkspaceStateKey.USAGE_STATS);

  // Collect all known stream IDs from all sources
  const allStreamIds = new Set<StreamTabId>();
  for (const record of [
    taskStatesRaw,
    executionIdsRaw,
    activeRunIdsRaw,
    parentStreamIdsRaw,
    runInstructionsRaw,
    outputFilesRaw,
    missingOutputsRaw,
    usageStatsRaw,
  ]) {
    for (const key of Object.keys(record)) {
      // Skip legacy bucket keys
      if (key === 'workflow' || key === 'toolUse') {
        const bucket = record[key];
        if (isNonNullObject(bucket)) {
          for (const innerKey of Object.keys(bucket)) {
            allStreamIds.add(innerKey as StreamTabId);
          }
        }
      } else {
        allStreamIds.add(key as StreamTabId);
      }
    }
  }
  // Also include stream log keys
  for (const key of streamLogKeys) {
    allStreamIds.add(key);
  }

  logger.info(`[Migration] Found ${allStreamIds.size} stream(s) to migrate`);

  // Extract task state entries (handles legacy workflow/toolUse format)
  const taskStateEntries = extractTaskStateEntries(taskStatesRaw);

  // Migrate each stream's data to disk
  await mapStreamTabStorage([...allStreamIds], (streamId) =>
    migrateStreamToStore(streamId, {
      taskStateEntries,
      executionIdsRaw,
      activeRunIdsRaw,
      parentStreamIdsRaw,
      runInstructionsRaw,
      outputFilesRaw,
      missingOutputsRaw,
      usageStatsRaw,
    }),
  );

  // Clear legacy workspace state keys
  logger.info('[Migration] Clearing legacy workspace state keys');
  await Promise.all([
    storage.update(WorkspaceStateKey.TASK_STATES, undefined),
    storage.update(WorkspaceStateKey.EXECUTION_IDS, undefined),
    storage.update(WorkspaceStateKey.ACTIVE_RUN_IDS, undefined),
    storage.update(WorkspaceStateKey.PARENT_STREAM_IDS, undefined),
    storage.update(WorkspaceStateKey.RUN_INSTRUCTIONS, undefined),
    storage.update(WorkspaceStateKey.OUTPUT_FILES, undefined),
    storage.update(WorkspaceStateKey.MISSING_OUTPUTS, undefined),
    storage.update(WorkspaceStateKey.USAGE_STATS, undefined),
  ]);

  logger.info('[Migration] Migration complete');
}

// -- Helpers ------------------------------------------------------------------

function loadRecord(
  storage: MementoStorage,
  key: WorkspaceStateKey,
): Record<string, unknown> {
  return StorageRecordSchema.parse(storage.get(key));
}

/**
 * Look up a stream's value in a record that may use the legacy
 * `{ workflow: { ...}, toolUse: { ... } }` bucket format.
 */
function extractFromRecord(
  record: Record<string, unknown>,
  streamId: string,
): unknown {
  if (streamId in record) return record[streamId];
  for (const bucket of ['workflow', 'toolUse'] as const) {
    const sub = record[bucket];
    if (isNonNullObject(sub) && streamId in sub) return sub[streamId];
  }
  return undefined;
}

function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractTaskStateEntries(
  raw: Record<string, unknown>,
): [string, unknown][] {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  const legacyBuckets = [raw.workflow, raw.toolUse].filter(isPlainObject);
  if (legacyBuckets.length > 0) {
    return legacyBuckets.flatMap((bucket) =>
      Object.entries(bucket).filter(([, v]) => isPlainObject(v)),
    );
  }

  return Object.entries(raw).filter(([, v]) => isPlainObject(v));
}

async function migrateStreamToStore(
  streamId: StreamTabId,
  data: {
    taskStateEntries: [string, unknown][];
    executionIdsRaw: Record<string, unknown>;
    activeRunIdsRaw: Record<string, unknown>;
    parentStreamIdsRaw: Record<string, unknown>;
    runInstructionsRaw: Record<string, unknown>;
    outputFilesRaw: Record<string, unknown>;
    missingOutputsRaw: Record<string, unknown>;
    usageStatsRaw: Record<string, unknown>;
  },
): Promise<void> {
  const store = getStreamTabStore(streamId);
  const writes: Promise<void>[] = [];

  // Meta: taskState + executionId + parentStreamId.
  // Preserve legacy activeRunId as a read-time migration hint so flattened
  // outputs/instructions can still prefer the run users last selected.
  const taskStateEntry = data.taskStateEntries.find(
    ([key]) => key === streamId,
  );
  const taskState = taskStateEntry
    ? TaskStateSchema.safeParse(taskStateEntry[1])
    : null;
  const executionId = extractFromRecord(data.executionIdsRaw, streamId);
  const activeRunId = extractFromRecord(data.activeRunIdsRaw, streamId);
  const parentStreamId = extractFromRecord(data.parentStreamIdsRaw, streamId);

  const meta: StreamTabMeta = {};
  if (taskState?.success) {
    meta.taskState = taskState.data as TaskState;
  }
  if (typeof executionId === 'string' && executionId.length > 0) {
    meta.executionId = executionId;
  }
  if (typeof activeRunId === 'string' && activeRunId.length > 0) {
    meta.activeRunId = normalizeRunId(activeRunId);
  }
  if (typeof parentStreamId === 'string' && parentStreamId.length > 0) {
    meta.parentStreamId = parentStreamId;
  }
  if (Object.keys(meta).length > 0) {
    writes.push(store.writeMeta(meta));
  }

  // Output files / missing outputs: legacy nested shape is tolerated on read
  // via Zod union in streamTabSchemas.ts — written as-is.
  const outputFilesData = extractFromRecord(data.outputFilesRaw, streamId);
  if (isNonNullObject(outputFilesData)) {
    writes.push(
      store.writeOutputFiles(outputFilesData as unknown as OutputFilesRecord),
    );
  }

  const missingOutputsData = extractFromRecord(
    data.missingOutputsRaw,
    streamId,
  );
  if (isNonNullObject(missingOutputsData)) {
    writes.push(
      store.writeMissingOutputs(
        missingOutputsData as unknown as MissingOutputsRecord,
      ),
    );
  }

  // Usage stats — normalize legacy single-value format to run-map format
  const usageStatsData = extractFromRecord(data.usageStatsRaw, streamId);
  if (isNonNullObject(usageStatsData)) {
    // Legacy format: bare { inputTokens, outputTokens, cost } without run wrapper
    const isLegacy =
      'inputTokens' in usageStatsData ||
      'outputTokens' in usageStatsData ||
      'cost' in usageStatsData;
    const normalized = isLegacy
      ? { [normalizeRunId(null)]: usageStatsData }
      : usageStatsData;
    writes.push(
      store.writeUsageStats(normalized as Record<string, TokenUsageStats>),
    );
  }

  // The new UI renders instructions as user-message log entries at run
  // start, but pre-refactor workflow runs never logged them — the text
  // only lived in this legacy memento record. Persist it verbatim as a
  // `legacyInstructions.json` side file so load-time backfills can restore
  // the visible instruction in archived workflow tabs.
  const runInstructionsData = extractFromRecord(
    data.runInstructionsRaw,
    streamId,
  );
  if (isNonNullObject(runInstructionsData)) {
    writes.push(store.writeLegacyInstructions(runInstructionsData));
  }

  await Promise.all(writes);
}
