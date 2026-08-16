// Hydrate durable workflow artifacts when a stream becomes focused.
//
// The shared `StreamSnapshotStore` is the single accumulator for round
// artifacts and per-run usage: `preload` seeds its memory from disk and
// replays any live deltas recorded meanwhile on top. Hydration no longer
// copies the round-artifact fields into `StreamSlice` (the live-fact adapter
// still maintains the pre-hydration mirror); renderers read the canonical
// projection (`projectStreamArtifacts`) directly, and this module owns only the
// async preload edge plus the invalidation that makes those reads repaint.
//
// `cumulativeUsage` is the one exception: exit summaries and the workflow
// dashboard still read it from `StreamSlice`, so hydration keeps mirroring just
// that field until those consumers migrate to the projection.

import { signal } from '@lit-labs/signals';

import { tryDefaultSession } from '@agent/runtime';
import {
  projectStreamArtifacts,
  type StreamArtifactProjection,
  type StreamArtifactReader,
} from '@controllers/session/StreamArtifactProjection';
import { sumUsageStats, type StreamTabId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  activeStreamId,
  getCliStateGeneration,
  isCliStreamRetired,
  patchStream,
  registerCliStateResetHook,
  setTransientNotice,
} from './cliState';
import { isChildStreamRemoved } from './childExecutions';
import { subscribeToSignalChanges } from './signalSubscription';

/** Bumped whenever the artifact projection changes: after a focus/`/plan`
 *  preload completes or when a live fact mutates the snapshot store. Renderers
 *  subscribe to this to repaint, and the projection memo keys on it. */
export const streamArtifactRevision = signal<number>(0);

/** Streams whose durable artifacts finished a successful preload this session.
 *  A stream absent here has no established disk provenance yet, so render-time
 *  reads fall back to the slice mirror instead of hitting unseeded getters
 *  (and their `warnIfUnseeded` noise) mid-preload (#10730). */
const hydratedArtifactStreams = new Set<StreamTabId>();

/** Per-stream projection memo, invalidated on `streamArtifactRevision`. The
 *  four renderers share one read-only clone per revision instead of re-cloning
 *  every round-indexed map and re-summing usage on each streaming repaint
 *  (#10731). */
const artifactProjectionMemo = new Map<StreamTabId, StreamArtifactProjection>();

registerCliStateResetHook(() => {
  hydratedArtifactStreams.clear();
  artifactProjectionMemo.clear();
  streamArtifactRevision.set(0);
});

/** Invalidate the projection memo and repaint artifact readers. */
export function bumpStreamArtifactRevision(): void {
  artifactProjectionMemo.clear();
  streamArtifactRevision.set(streamArtifactRevision.get() + 1);
}

/** Mark a stream's durable artifacts hydrated and invalidate the projection
 *  memo. The focus-hydration owner calls this on success; direct store
 *  load/preload paths (resume) call it after their own seed so a focused
 *  stream loaded outside the focus subscription still repaints. */
export function markArtifactStreamHydrated(streamId: StreamTabId): void {
  hydratedArtifactStreams.add(streamId);
  bumpStreamArtifactRevision();
}

/** Read the canonical artifact projection for one stream from the live session.
 *  Returns `undefined` when no default session exists yet (harness/tests) or
 *  when the stream has not completed a preload this session, letting callers
 *  fall back to their slice mirrors exactly as before. */
export function readStreamArtifacts(
  streamId: StreamTabId,
): StreamArtifactProjection | undefined {
  const session = tryDefaultSession();
  if (!session || !hydratedArtifactStreams.has(streamId)) return undefined;
  const cached = artifactProjectionMemo.get(streamId);
  if (cached !== undefined) return cached;
  const projection = projectStreamArtifacts(session.snapshots, streamId);
  artifactProjectionMemo.set(streamId, projection);
  return projection;
}

function streamCanReceiveArtifacts(
  streamId: StreamTabId,
  generation: number,
  requestIsCurrent: () => boolean,
): boolean {
  return (
    requestIsCurrent() &&
    generation === getCliStateGeneration() &&
    !isCliStreamRetired(streamId) &&
    !isChildStreamRemoved(streamId)
  );
}

/**
 * Preload one stream from the canonical artifact accumulator and invalidate
 * the artifact projection. Callers own request currentness: focus hydration
 * invalidates on a focus change, while `/plan` keeps the stream id it
 * captured before awaiting.
 */
export async function hydrateStreamArtifacts(
  store: StreamArtifactReader,
  streamId: StreamTabId,
  requestIsCurrent: () => boolean = () => true,
  onError?: (error: unknown) => void,
): Promise<boolean> {
  const generation = getCliStateGeneration();
  try {
    // `preload` warms only this stream. `load([streamId])` would incorrectly
    // claim an authoritative complete stream set and evict sibling state.
    await store.preload([streamId]);
  } catch (error) {
    if (!streamCanReceiveArtifacts(streamId, generation, requestIsCurrent)) {
      return false;
    }
    if (onError) {
      onError(error);
    } else {
      setTransientNotice(
        `Could not load workflow artifacts: ${toErrorMessage(error)}`,
      );
    }
    return false;
  }
  if (!streamCanReceiveArtifacts(streamId, generation, requestIsCurrent)) {
    return false;
  }
  // The store already ordered the seed against live facts (including a
  // `clearMissingOutputs` reset — see its overlay `reset` flag), so its
  // accumulated usage replaces the slice's. Round artifacts and the work plan
  // no longer mirror here; renderers read `projectStreamArtifacts` directly.
  const runUsage = [...store.getRunUsage(streamId).values()];
  patchStream(streamId, (slice) => ({
    ...slice,
    cumulativeUsage: runUsage.length
      ? sumUsageStats(runUsage)
      : slice.cumulativeUsage,
  }));
  markArtifactStreamHydrated(streamId);
  return true;
}

/**
 * Hydrate artifacts for the initial and subsequently focused streams.
 *
 * A late disk read cannot resurrect a retired/removed stream. If focus moves
 * while I/O is pending, the stale result is discarded; returning to that
 * stream starts a fresh read.
 */
export function subscribeStreamArtifacts(
  store: StreamArtifactReader,
): () => void {
  let previous = activeStreamId.get();
  let focusRevision = 0;
  const hydrate = (streamId: StreamTabId): void => {
    const revision = ++focusRevision;
    void hydrateStreamArtifacts(
      store,
      streamId,
      () => focusRevision === revision && activeStreamId.get() === streamId,
    );
  };
  if (previous) hydrate(previous);

  return subscribeToSignalChanges([activeStreamId], () => {
    const next = activeStreamId.get();
    const changed = next !== previous;
    previous = next;
    if (!changed) return;
    if (!next) {
      ++focusRevision;
      return;
    }
    hydrate(next);
  });
}
