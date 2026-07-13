/**
 * Cross-launch stream snapshot persistence (audit item D / trajectory #19).
 *
 * The desktop app already restores auth + the workspace path on relaunch
 * but the rail of in-flight agent runs evaporated when the app exited,
 * so users had no way to find their previous work. This module
 * persists a slim, on-disk snapshot of the active stream rail and
 * hydrates it on launch as visual "ghost" entries — the user can see
 * the runs they had going and click through to a "Resume run" path
 * that either reuses the existing storage-backed resume IPC (when
 * taskState is recoverable) or surfaces a clear "start fresh" prompt.
 *
 * Live re-establishment of agent runtimes is intentionally out of
 * scope here — that's tracked as a Phase 2 follow-up. Just shipping
 * the visual rail closes the user-visible "where did my run go?" gap.
 *
 * Persistence layout: a single `streams.json` under
 * `app.getPath('userData')`. Atomic writes (temp + rename) are
 * provided by the underlying `JsonStore`, so a crash mid-flush leaves
 * the previous file intact rather than corrupting the snapshot.
 */

import { JsonStore } from '@platform/defaults/jsonStore';
import {
  RestoredStreamsFileSchema,
  STREAM_PHASE,
  type RestoredStreamSnapshot,
  type RestoredStreamsFile,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import { createFlushableDebounce } from '@utils/core';

const STREAMS_KEY = 'restoredStreams';
export const DESKTOP_STREAM_SNAPSHOT_WRITE_DEBOUNCE_MS = 100;
const RESTART_REPAIR_PHASES: ReadonlySet<StreamPhase> = new Set([
  STREAM_PHASE.RUNNING,
  STREAM_PHASE.WAITING,
]);

export interface DesktopStreamSnapshotStore {
  /**
   * All previously-persisted snapshots. Prior in-flight statuses are preserved
   * only long enough for desktop startup repair to classify them as resumable
   * (`waiting`) or dead (`error`); all other restored states are inert ghosts.
   */
  readonly hydrated: readonly RestoredStreamSnapshot[];
  /**
   * Persist (insert or update) a single stream snapshot.
   * Idempotent: subsequent calls with the same `streamId` overwrite.
   */
  upsert(snapshot: RestoredStreamSnapshot): Promise<void>;
  /** Remove a snapshot. Safe to call when the stream isn't tracked. */
  remove(streamId: StreamTabId): Promise<void>;
  /** Replace the entire snapshot list. */
  replaceAll(snapshots: RestoredStreamSnapshot[]): Promise<void>;
  /** Persist any pending debounced snapshot update. */
  flush(): Promise<void>;
  /** Current in-memory snapshot list (post-hydrate). */
  getAll(): RestoredStreamSnapshot[];
}

/**
 * Open the persisted snapshot file and return a write-through store.
 * The file is created on first write — opening a non-existent file
 * yields an empty in-memory state.
 */
export async function openDesktopStreamSnapshotStore(
  filePath: string,
): Promise<DesktopStreamSnapshotStore> {
  const store = await JsonStore.open(filePath, {
    corruptionPolicy: 'fail',
  });
  const raw = store.get<unknown>(STREAMS_KEY);

  // Live in-memory list keyed by streamId, seeded from the persisted file.
  // We still rewrite the whole `streams` array, but frequent status/activity
  // upserts share one debounced write. Destructive edits stay immediate so
  // callers can rely on durability when remove()/replaceAll() resolve.
  const live = new Map<StreamTabId, RestoredStreamSnapshot>(
    parseHydrated(raw).map((s) => [s.streamId, s]),
  );
  let pendingUpsertWaiters: Array<{
    resolve(): void;
    reject(error: unknown): void;
  }> = [];
  let writeChain = Promise.resolve();
  let writeGeneration = 0;

  function currentFile(): RestoredStreamsFile {
    return {
      version: 1,
      streams: [...live.values()],
    };
  }

  async function persist(): Promise<void> {
    await store.set(STREAMS_KEY, currentFile());
  }

  function enqueuePersist(
    waiters: typeof pendingUpsertWaiters = [],
  ): Promise<void> {
    writeGeneration += 1;
    const write = writeChain.then(persist, persist);
    writeChain = write.catch(() => {});
    void write.then(
      () => {
        for (const waiter of waiters) waiter.resolve();
      },
      (error: unknown) => {
        for (const waiter of waiters) waiter.reject(error);
      },
    );
    return write;
  }

  // The debounce batches successive `upsert()` writes; `persistPendingUpserts`
  // (used both when it fires and on immediate/flush paths) is the actual work,
  // so this site only needs the timer's schedule/cancel/pending primitives —
  // its own `flush()` isn't used since the awaited write chain below is what
  // callers actually need to observe completion.
  const writeDebounce = createFlushableDebounce(() => {
    void persistPendingUpserts().catch(() => {
      // Individual upsert promises receive the rejection through their waiters.
    });
  }, DESKTOP_STREAM_SNAPSHOT_WRITE_DEBOUNCE_MS);

  function clearPendingDebounce(): typeof pendingUpsertWaiters {
    writeDebounce.cancel();
    const waiters = pendingUpsertWaiters;
    pendingUpsertWaiters = [];
    return waiters;
  }

  function persistPendingUpserts(): Promise<void> {
    const waiters = clearPendingDebounce();
    return waiters.length > 0 ? enqueuePersist(waiters) : writeChain;
  }

  function schedulePersist(): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      pendingUpsertWaiters.push({ resolve, reject });
    });
    writeDebounce.schedule();
    return promise;
  }

  async function persistImmediately(): Promise<void> {
    const waiters = clearPendingDebounce();
    await enqueuePersist(waiters);
  }

  async function flushPendingWrites(): Promise<void> {
    for (;;) {
      const generationBeforeFlush = writeGeneration;
      await persistPendingUpserts();
      if (
        !writeDebounce.pending &&
        pendingUpsertWaiters.length === 0 &&
        writeGeneration === generationBeforeFlush
      ) {
        return;
      }
    }
  }

  return {
    // Bot review (#3819): on macOS the store is created once and shared
    // across window recreations via `app.on('activate')`. A frozen
    // `hydrated` array would let previously-deleted streams reappear as
    // ghosts on window reopen and would miss streams created during the
    // prior window session. Expose `hydrated` as a getter so each
    // bridge construction reads the current `live` map.
    get hydrated() {
      return [...live.values()];
    },
    async upsert(snapshot) {
      live.set(snapshot.streamId, snapshot);
      await schedulePersist();
    },
    async remove(streamId) {
      if (!live.delete(streamId)) return;
      await persistImmediately();
    },
    async replaceAll(snapshots) {
      live.clear();
      for (const snapshot of snapshots) {
        live.set(snapshot.streamId, snapshot);
      }
      await persistImmediately();
    },
    async flush() {
      await flushPendingWrites();
    },
    getAll() {
      return [...live.values()];
    },
  };
}

/**
 * Parse the persisted blob, returning a normalized list. A missing snapshot
 * value yields an empty list. Invalid present data fails the open so the
 * caller can disable snapshot persistence without overwriting the source.
 */
function parseHydrated(raw: unknown): RestoredStreamSnapshot[] {
  if (raw == null) return [];
  const parsed = RestoredStreamsFileSchema.safeParse(raw);
  if (!parsed.success) throw parsed.error;
  // Preserve in-flight phases so startup repair can classify them. A finished
  // or already-inert prior phase remains an inactive ghost on the next launch.
  return parsed.data.streams.map((s) => ({
    ...s,
    lastKnownStatus: RESTART_REPAIR_PHASES.has(s.lastKnownStatus)
      ? s.lastKnownStatus
      : STREAM_PHASE.COMPLETED,
  }));
}
