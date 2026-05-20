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
  emptyRestoredStreamsFile,
  RestoredStreamsFileSchema,
  STREAM_STATUS,
  type RestoredStreamSnapshot,
  type RestoredStreamsFile,
  type StreamTabId,
} from '@shared/schemas';

const STREAMS_KEY = 'restoredStreams';

export interface DesktopStreamSnapshotStore {
  /**
   * All previously-persisted snapshots, with `lastKnownStatus`
   * normalised to `stopped` because we cannot tell from cold start
   * whether the agent actually finished — the renderer should treat
   * them as inactive ghosts.
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
  /** Current in-memory snapshot list (post-hydrate). */
  getAll(): RestoredStreamSnapshot[];
}

interface OpenOptions {
  /** Optional logger override (defaults to `console`). */
  log?: Pick<Console, 'warn'>;
}

/**
 * Open the persisted snapshot file and return a write-through store.
 * The file is created on first write — opening a non-existent file
 * yields an empty in-memory state.
 */
export async function openDesktopStreamSnapshotStore(
  filePath: string,
  options: OpenOptions = {},
): Promise<DesktopStreamSnapshotStore> {
  const log = options.log ?? console;
  const store = await JsonStore.open(filePath);
  const raw = store.get<unknown>(STREAMS_KEY);

  // Live in-memory list keyed by streamId, seeded from the persisted file.
  // We always rewrite the whole `streams` array on every change — the rail
  // rarely has more than a dozen entries, so the cost is trivial and the
  // code stays simple (no merge bugs vs. partial updates).
  const live = new Map<StreamTabId, RestoredStreamSnapshot>(
    parseHydrated(raw, log).map((s) => [s.streamId, s]),
  );

  async function persist(): Promise<void> {
    const file: RestoredStreamsFile = {
      version: 1,
      streams: [...live.values()],
    };
    await store.set(STREAMS_KEY, file);
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
      await persist();
    },
    async remove(streamId) {
      if (!live.delete(streamId)) return;
      await persist();
    },
    async replaceAll(snapshots) {
      live.clear();
      for (const snapshot of snapshots) {
        live.set(snapshot.streamId, snapshot);
      }
      await persist();
    },
    getAll() {
      return [...live.values()];
    },
  };
}

/**
 * Parse the persisted blob, returning a normalized list. A malformed
 * or missing file yields an empty list — never throw at startup; a
 * corrupt snapshot must not block the user from launching the app.
 */
function parseHydrated(
  raw: unknown,
  log: Pick<Console, 'warn'>,
): RestoredStreamSnapshot[] {
  if (raw == null) return [];
  const parsed = RestoredStreamsFileSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn(
      '[texra-desktop] Discarding malformed stream snapshot file',
      parsed.error.issues.slice(0, 3),
    );
    return emptyRestoredStreamsFile().streams;
  }
  // Normalise status to "stopped" — we don't know if the agent
  // actually finished, and we explicitly never want the rail to claim
  // a run is still running just because it was running last time.
  return parsed.data.streams.map((s) => ({
    ...s,
    lastKnownStatus: STREAM_STATUS.STOPPED,
  }));
}
