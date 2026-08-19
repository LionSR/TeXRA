// Hydrate durable workflow artifacts when a stream becomes focused.
//
// The shared `StreamSnapshotStore` is the single accumulator for round
// artifacts and per-run usage: `preload` seeds its memory from disk and
// replays any live deltas recorded meanwhile on top. Hydration copies none of
// the round-artifact fields into `StreamSlice`, and no other mirror of them
// exists: the live-fact adapter lands its writes on the shared store directly,
// and renderers read the canonical projection (`projectStreamArtifacts`). This
// module owns only the async preload edge plus the invalidation that makes
// those reads repaint. Exit summaries and workflow-task metadata read
// `readStreamArtifacts` the same way the renderers do.

import { signal } from '@lit-labs/signals';

import { tryDefaultSession } from '@agent/runtime';
import {
  projectStreamArtifacts,
  type StreamArtifactProjection,
  type StreamArtifactReader,
} from '@controllers/session/StreamArtifactProjection';
import { type StreamTabId, type TokenUsageStats } from '@shared/schemas';
import { subscribeToSignalChanges } from '@shared/signals';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  activeStreamId,
  getCliStateGeneration,
  isCliStreamRetired,
  registerCliStateResetHook,
  setTransientNotice,
  type StreamSlice,
} from './cliState';
import { isChildStreamRemoved } from './childExecutions';

/** Bumped whenever the artifact projection changes: after a focus/`/plan`
 *  preload completes or when a live fact mutates the snapshot store. Renderers
 *  subscribe to this to repaint, and the projection memo keys on it. */
export const streamArtifactRevision = signal<number>(0);

/** Streams whose artifacts have established provenance this session: a
 *  completed preload, an authoritative `load` (resume reconciliation), or a
 *  live artifact write the adapter marked hydrated (see
 *  `readStreamArtifacts`). A stream absent here has no established disk
 *  provenance yet, so render-time reads return `undefined` — callers fall
 *  back to empty defaults — instead of hitting unseeded getters (and their
 *  `warnIfUnseeded` noise) mid-preload (#10730). */
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
function bumpStreamArtifactRevision(): void {
  artifactProjectionMemo.clear();
  streamArtifactRevision.set(streamArtifactRevision.get() + 1);
}

/** Mark a stream's durable artifacts hydrated and invalidate the projection
 *  memo. The focus-hydration owner calls this on success; direct store
 *  preload paths (resume) call it after their own seed so a focused stream
 *  loaded outside the focus subscription still repaints. */
export function markArtifactStreamHydrated(streamId: StreamTabId): void {
  hydratedArtifactStreams.add(streamId);
  bumpStreamArtifactRevision();
}

/** Prepare reconciliation for an authoritative full-set `load` of `retained`.
 *  `load` evicts every other record, so capture the markers it will evict up
 *  front (plus the active stream, whose first focus preload may still be in
 *  flight with no marker yet). Call `dropStale()` before awaiting `load` so the
 *  hydration gate stays honest across the async seed window (eviction is sync
 *  at the start of `load`); `reconcile()` after a successful `load` (and again
 *  after focus) re-drops those stale markers and marks the retained streams
 *  hydrated. A stale in-flight preload that re-adds an evicted stream is
 *  cleared either way, while a stream legitimately preloaded after the load is
 *  preserved (it was never in the captured stale set). */
export function beginLoadedStreamsReconcile(retained: readonly StreamTabId[]): {
  readonly dropStale: () => void;
  readonly reconcile: () => void;
} {
  const retainedSet = new Set(retained);
  const stale = new Set<StreamTabId>();
  for (const streamId of hydratedArtifactStreams) {
    if (!retainedSet.has(streamId)) stale.add(streamId);
  }
  const active = activeStreamId.get();
  if (active !== undefined && !retainedSet.has(active)) stale.add(active);

  const apply = (markRetained: boolean): void => {
    for (const streamId of stale) hydratedArtifactStreams.delete(streamId);
    if (markRetained) {
      for (const streamId of retained) hydratedArtifactStreams.add(streamId);
    }
    bumpStreamArtifactRevision();
  };
  return {
    dropStale: () => apply(false),
    reconcile: () => apply(true),
  };
}

/** Read the canonical artifact projection for one stream from the live session.
 *  Returns `undefined` when no default session exists yet (harness/tests) or
 *  when the stream has no established provenance this session: no completed
 *  preload or resume `load`, and no live artifact write. `sessionSignalsAdapter` marks a stream
 *  hydrated on every live files, missing-outputs, compile-failures, usage,
 *  todos, or plan write, so a never-focused stream with live writes projects
 *  here too; callers default to empty values (`artifacts?.todos ?? []`) while
 *  the gate holds. */
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

/** The usage a caller presents for one stream: the canonical store projection
 *  (durable + live) first, then the latest per-run usage gauge. Owned here so
 *  the exit summary and the workflow dashboard can't drift in precedence. */
export function streamPreferredUsage(
  streamId: StreamTabId | undefined,
  slice: StreamSlice | undefined,
): TokenUsageStats | undefined {
  const projected =
    streamId !== undefined
      ? readStreamArtifacts(streamId)?.cumulativeUsage
      : undefined;
  return projected ?? slice?.usage;
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
