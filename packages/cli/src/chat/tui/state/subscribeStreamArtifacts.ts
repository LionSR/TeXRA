// Hydrate durable workflow artifacts when a stream becomes focused.
//
// The shared `StreamSnapshotStore` is the single accumulator for round
// artifacts and per-run usage: `preload` seeds its memory from disk and
// replays any live deltas recorded meanwhile on top. Hydration copies none of
// the round-artifact fields into `StreamSlice`, and no other mirror of them
// exists: the live-fact adapter lands its writes on the shared store directly,
// renderers read the canonical projection (`projectStreamArtifacts`), and the
// store answers whether a record has provenance yet (`hasProvenance`). This
// module owns only the async preload edge plus the invalidation that makes
// those reads repaint. Exit summaries and workflow-task metadata read
// `readStreamArtifacts` the same way the renderers do.

import { signal } from '@lit-labs/signals';

import { tryDefaultSession } from '@agent/runtime';
import { type StreamTabId } from '@shared/schemas';
import { subscribeToSignalChanges } from '@shared/signals';
import {
  StreamSnapshotPreloadError,
  type WorkPlanProvenance,
} from '@transcript';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  projectStreamArtifacts,
  type StreamArtifactProjection,
  type StreamArtifactReader,
} from './streamArtifactProjection';
import {
  activeStreamId,
  getCliStateGeneration,
  isCliStreamRetired,
  registerCliStateResetHook,
  setTransientNotice,
} from './cliState';
import { isChildStreamRemoved } from './childExecutions';

/** Bumped whenever the artifact projection changes: after a focus/`/plan`
 *  preload completes or when a live fact mutates the snapshot store. Renderers
 *  subscribe to this to repaint, and the projection memo keys on it. */
export const streamArtifactRevision = signal<number>(0);

/** Per-stream projection memo, invalidated on `streamArtifactRevision`. The
 *  four renderers share one projection per revision instead of re-summing usage
 *  on each streaming repaint (#10731). The store's round-indexed reads are live
 *  readonly views now, so the memo no longer amortizes a clone — clearing it on
 *  every artifact write is what keeps a cached projection from spanning a
 *  mutation. */
const artifactProjectionMemo = new Map<StreamTabId, StreamArtifactProjection>();

registerCliStateResetHook(() => {
  artifactProjectionMemo.clear();
  streamArtifactRevision.set(0);
});

/** Invalidate the projection memo and repaint artifact readers. Called after
 *  any write the store has already accepted — a live artifact fact, a
 *  completed focus preload, or a resume `load` — since the store, not this
 *  module, owns whether a record has provenance. */
export function bumpStreamArtifactRevision(): void {
  artifactProjectionMemo.clear();
  streamArtifactRevision.set(streamArtifactRevision.get() + 1);
}

/** Read the canonical artifact projection for one stream from the live session.
 *  Returns `undefined` when no default session exists yet (harness/tests) or
 *  when the store reports no provenance for the record: no completed preload
 *  or resume `load`, and no live write eagerly applied ahead of a seed. The
 *  store is the single owner of that fact (`hasProvenance`), so a
 *  never-focused stream with live writes projects here too; callers default to
 *  empty values (`artifacts?.todos ?? []`) while the gate holds — instead of
 *  hitting unseeded getters (and their `warnIfUnseeded` noise) mid-preload
 *  (#10730). */
export function readStreamArtifacts(
  streamId: StreamTabId,
): StreamArtifactProjection | undefined {
  const session = tryDefaultSession();
  if (!session) return undefined;
  if (!session.snapshots.hasProvenance(streamId)) {
    // A released record (a finished, unfocused stream) still answers the
    // roster's token column from the summary mirror the store publishes on
    // every usage write; its artifacts re-seed on the next focus.
    const cumulativeUsage =
      session.transcripts.getSummaryMeta(streamId)?.cumulativeUsage;
    return cumulativeUsage
      ? {
          outputFilesByRound: {},
          missingOutputsByRound: {},
          compileFailuresByRound: {},
          cumulativeUsage,
          todos: [],
          plan: null,
        }
      : undefined;
  }
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

/** Complete, partially authoritative, and unusable preload outcomes. */
type StreamArtifactHydrationOutcome =
  | { readonly kind: 'complete' }
  | {
      readonly kind: 'partial';
      readonly workPlanProvenance: WorkPlanProvenance;
      readonly error: unknown;
    }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * Preload one stream from the canonical artifact accumulator and invalidate
 * the artifact projection. Callers own request currentness and error
 * presentation. `undefined` means the request was superseded; a partial
 * outcome's work plan is usable only for the fields `workPlanProvenance`
 * vouches for at that instant — the store keeps answering that question live
 * (`snapshots.workPlanProvenance`) as later writes and seeds establish more.
 */
export async function hydrateStreamArtifacts(
  store: StreamArtifactReader,
  streamId: StreamTabId,
  requestIsCurrent: () => boolean = () => true,
): Promise<StreamArtifactHydrationOutcome | undefined> {
  const generation = getCliStateGeneration();
  try {
    // `preload` warms only this stream. `load([streamId])` would incorrectly
    // claim an authoritative complete stream set and evict sibling state.
    await store.preload([streamId], { reportArtifactAuthority: true });
  } catch (error) {
    if (!streamCanReceiveArtifacts(streamId, generation, requestIsCurrent)) {
      return undefined;
    }
    if (
      error instanceof StreamSnapshotPreloadError &&
      error.streamId === streamId
    ) {
      if (error.baselineEstablished) {
        bumpStreamArtifactRevision();
      }
      return {
        kind: 'partial',
        workPlanProvenance: error.workPlanProvenance,
        error,
      };
    }
    return { kind: 'failed', error };
  }
  if (!streamCanReceiveArtifacts(streamId, generation, requestIsCurrent)) {
    return undefined;
  }
  bumpStreamArtifactRevision();
  return { kind: 'complete' };
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
    ).then((outcome) => {
      if (!outcome || outcome.kind === 'complete') return;
      setTransientNotice(
        `Could not load workflow artifacts: ${toErrorMessage(outcome.error)}`,
      );
    });
  };
  if (previous) hydrate(previous);

  return subscribeToSignalChanges([activeStreamId], () => {
    const next = activeStreamId.get();
    if (next === previous) return;
    previous = next;
    if (!next) {
      ++focusRevision;
      return;
    }
    hydrate(next);
  });
}
