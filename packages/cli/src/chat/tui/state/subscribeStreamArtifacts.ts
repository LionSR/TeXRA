// Hydrate durable workflow artifacts when a stream becomes focused.
//
// The shared `StreamSnapshotStore` is the single accumulator for round
// artifacts and per-run usage: `preload` seeds its memory from disk and
// replays any live deltas recorded meanwhile on top, so the focused-stream
// load just copies the store's accumulated state into the slice — there is
// no CLI-side live/durable merge.

import { sumUsageStats, type StreamTabId } from '@shared/schemas';
import type { StreamSnapshotStore } from '@transcript';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  activeStreamId,
  getCliStateGeneration,
  isCliStreamRetired,
  patchStream,
  setTransientNotice,
} from './cliState';
import { isChildStreamRemoved } from './childExecutions';
import { subscribeToSignalChanges } from './signalSubscription';

/** The store surface the TUI projects accumulated artifact/usage state from. */
export type StreamArtifactReader = Pick<
  StreamSnapshotStore,
  | 'preload'
  | 'getOutputFiles'
  | 'getMissingOutputs'
  | 'getCompileFailures'
  | 'getRunUsage'
>;

function streamCanReceiveArtifacts(
  streamId: StreamTabId,
  generation: number,
  focusIsCurrent: () => boolean,
): boolean {
  return (
    focusIsCurrent() &&
    generation === getCliStateGeneration() &&
    activeStreamId.get() === streamId &&
    !isCliStreamRetired(streamId) &&
    !isChildStreamRemoved(streamId)
  );
}

async function hydrateFocusedStream(
  store: StreamArtifactReader,
  streamId: StreamTabId,
  focusIsCurrent: () => boolean,
): Promise<void> {
  const generation = getCliStateGeneration();
  try {
    // `preload` warms only this stream. `load([streamId])` would incorrectly
    // claim an authoritative complete stream set and evict sibling state.
    await store.preload([streamId]);
  } catch (error) {
    if (!streamCanReceiveArtifacts(streamId, generation, focusIsCurrent)) {
      return;
    }
    setTransientNotice(
      `Could not load workflow artifacts: ${toErrorMessage(error)}`,
    );
    return;
  }
  if (!streamCanReceiveArtifacts(streamId, generation, focusIsCurrent)) {
    return;
  }
  // The store already ordered the seed against live facts (including a
  // `clearMissingOutputs` reset — see its overlay `reset` flag), so its
  // accumulated state replaces the slice's wholesale.
  const runUsage = [...store.getRunUsage(streamId).values()];
  patchStream(streamId, (slice) => ({
    ...slice,
    outputFilesByRound: store.getOutputFiles(streamId),
    missingOutputsByRound: store.getMissingOutputs(streamId),
    compileFailuresByRound: store.getCompileFailures(streamId),
    cumulativeUsage: runUsage.length
      ? sumUsageStats(runUsage)
      : slice.cumulativeUsage,
  }));
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
    void hydrateFocusedStream(
      store,
      streamId,
      () => focusRevision === revision,
    );
  };
  if (previous) hydrate(previous);

  return subscribeToSignalChanges([activeStreamId], () => {
    const next = activeStreamId.get();
    const changed = next !== previous;
    previous = next;
    if (!changed) return;
    if (!next) {
      focusRevision += 1;
      return;
    }
    hydrate(next);
  });
}
