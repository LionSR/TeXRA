// Restore durable workflow artifacts when a stream becomes focused.
//
// Live run facts and the snapshot store share the same round-indexed shape.
// The focused-stream load therefore merges once at this boundary, with newer
// live rounds taking precedence over the disk snapshot.

import type { StreamTabId, StreamSnapshot } from '@shared/schemas';
import type { StreamSnapshotStore } from '@transcript';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  activeStreamId,
  getCliStateGeneration,
  isCliStreamRetired,
  patchStream,
  setTransientNotice,
  streamArtifactRevision,
  type StreamArtifactRevision,
} from './cliState';
import { isChildStreamRemoved } from './childExecutions';
import { subscribeToSignalChanges } from './signalSubscription';

type StreamArtifactSnapshot = Pick<
  StreamSnapshot,
  'outputFilesByRound' | 'missingOutputsByRound' | 'compileFailuresByRound'
>;

export type StreamArtifactReader = Pick<
  StreamSnapshotStore,
  'preload' | 'read'
>;

function streamCanReceiveArtifacts(
  streamId: StreamTabId,
  generation: number,
): boolean {
  return (
    generation === getCliStateGeneration() &&
    activeStreamId.get() === streamId &&
    !isCliStreamRetired(streamId) &&
    !isChildStreamRemoved(streamId)
  );
}

function mergeArtifactSnapshot(
  streamId: StreamTabId,
  snapshot: StreamArtifactSnapshot,
  revisionAtStart: StreamArtifactRevision,
): void {
  const currentRevision = streamArtifactRevision(streamId);
  patchStream(streamId, (slice) => {
    const missingOutputsByRound =
      currentRevision.missingOutputsReset ===
      revisionAtStart.missingOutputsReset
        ? {
            ...snapshot.missingOutputsByRound,
            ...slice.missingOutputsByRound,
          }
        : slice.missingOutputsByRound;
    return {
      ...slice,
      outputFilesByRound: {
        ...snapshot.outputFilesByRound,
        ...slice.outputFilesByRound,
      },
      missingOutputsByRound,
      compileFailuresByRound: {
        ...snapshot.compileFailuresByRound,
        ...slice.compileFailuresByRound,
      },
    };
  });
}

async function hydrateFocusedStream(
  store: StreamArtifactReader,
  streamId: StreamTabId,
): Promise<void> {
  const generation = getCliStateGeneration();
  const artifactRevision = streamArtifactRevision(streamId);
  try {
    // `preload` warms only this stream. `load([streamId])` would incorrectly
    // claim an authoritative complete stream set and evict sibling state.
    await store.preload([streamId]);
    const snapshot = await store.read(streamId);
    if (!streamCanReceiveArtifacts(streamId, generation)) return;
    mergeArtifactSnapshot(streamId, snapshot, artifactRevision);
  } catch (error) {
    if (!streamCanReceiveArtifacts(streamId, generation)) return;
    setTransientNotice(
      `Could not load workflow artifacts: ${toErrorMessage(error)}`,
    );
  }
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
  if (previous) void hydrateFocusedStream(store, previous);

  return subscribeToSignalChanges([activeStreamId], () => {
    const next = activeStreamId.get();
    const changed = next !== previous;
    previous = next;
    if (!next || !changed) return;
    void hydrateFocusedStream(store, next);
  });
}
