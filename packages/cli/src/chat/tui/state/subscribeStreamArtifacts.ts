// Hydrate durable workflow artifacts when a stream becomes focused.
//
// The shared `StreamSnapshotStore` is the single accumulator for round
// artifacts and per-run usage: `preload` seeds its memory from disk and
// replays any live deltas recorded meanwhile on top. The TUI no longer copies
// that state into `StreamSlice`; renderers read the canonical projection
// (`projectStreamArtifacts`) directly, and this module owns only the async
// preload edge plus the invalidation that makes those reads repaint.

import { signal } from '@lit-labs/signals';

import { tryDefaultSession } from '@agent/runtime';
import {
  projectStreamArtifacts,
  type StreamArtifactProjection,
  type StreamArtifactReader,
} from '@controllers/session/StreamArtifactProjection';
import { type StreamTabId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  activeStreamId,
  getCliStateGeneration,
  isCliStreamRetired,
  setTransientNotice,
} from './cliState';
import { isChildStreamRemoved } from './childExecutions';
import { subscribeToSignalChanges } from './signalSubscription';

export type { StreamArtifactProjection, StreamArtifactReader };

/** Bumped whenever an async preload changes what the projection reads. */
export const streamArtifactRevision = signal<number>(0);

function bumpStreamArtifactRevision(): void {
  streamArtifactRevision.set(streamArtifactRevision.get() + 1);
}

/** Read the canonical artifact projection for one stream from the live session.
 *  Returns `undefined` when no default session exists yet (harness/tests),
 *  letting callers fall back to their slice mirrors exactly as before. */
export function readStreamArtifacts(
  streamId: StreamTabId,
): StreamArtifactProjection | undefined {
  const session = tryDefaultSession();
  return session
    ? projectStreamArtifacts(session.snapshots, streamId)
    : undefined;
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
  bumpStreamArtifactRevision();
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
