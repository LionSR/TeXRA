// Mirror StreamLogStore user/model/tool entries into
// `streams[].entries` (state/cliState.ts). Approval/permission
// entries land in side panels and modals; tool rows render inline alongside
// assistant prose.
//
// The projection is a fold over the store's entry-level change feed: every
// `StreamLogStore.onChange` emission carries a `StreamLogDelta` (appended
// entries + dirtied entries by value + a monotonic emission seq), and the
// per-stream `TranscriptFoldState` on the slice is advanced in O(delta) per
// tick. A fresh consumer, an emission gap, a reset emission, or a
// projection-mode flip rebuilds the state from `getRange(0)` through the
// same application path — the from-scratch build IS the resync path.
//
// The fold rules themselves (entry rendering, settled-prefix promotion, item
// maintenance) live in `./transcriptFold`; this module owns the store
// subscription, batched drain, and the imperative sync/eviction/focus surface.
//
// Secrets are redacted at record time by TexraTranscriptRecorder, which is
// what every host and the HTML export share. The `redactSecrets` calls below
// remain only to cover rows persisted before that landed; they are idempotent
// on already-redacted text.

import { isDeepStrictEqual } from 'node:util';

import { defaultSession } from '@agent/runtime';
import {
  ActiveSkillsSnapshotSchema,
  AgentCategory,
  MESSAGE_TYPES,
  type StreamTabId,
} from '@shared/schemas';
import {
  isActivePhase,
  isTranscriptSettlementPhase,
} from '@shared/streams/streamStatus';
import { StreamLogDeltaBuffer } from '@transcript';
import { createFlushableDebounce } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  activeStreamId,
  focusStream,
  getCliStateGeneration,
  isCliStreamRetired,
  patchStream,
  registerCliStateResetHook,
  setTransientNotice,
  streams,
  type ConversationEntry,
} from './cliState';
import { isChildStreamRemoved } from './childExecutions';
import { subscribeToSignalChanges } from './signalSubscription';
import {
  applyStreamChanges,
  compactWorkflowEntries,
  createTranscriptFoldState,
  finalizeSettledPrefix,
  isFullLogChildStream,
  logEntryStreamIsRunning,
  newFoldChangeFlags,
  resetTranscriptFoldState,
  workflowOperationalLatestLine,
  type FoldContext,
} from './transcriptFold';

// Re-export the fold primitive tests (and any other subscribeStreamLog
// consumers) still import from this module after the fold extraction.
export { finalizeSettledPrefix };

// Coalesce bursts into a single render without visibly delaying the
// first paint. 200ms looks like a hang on short replies (an entire reply
// can land before the first sync fires); one animation frame is enough
// to batch chunks and keeps the transcript feeling live.
const STREAM_SYNC_THROTTLE_MS = 16;

/**
 * Store-emitted deltas awaiting the next batched sync, coalesced per stream.
 * Written by the `onChange` subscriber; drained by `syncStreamLog`, so an
 * out-of-band sync (status transition, focus switch, tests) folds the same
 * buffered changes instead of rescanning the log.
 */
interface PendingStreamDeltas {
  readonly buffer: StreamLogDeltaBuffer;
  generation: number;
}

const PENDING_DELTAS = new Map<StreamTabId, PendingStreamDeltas>();

registerCliStateResetHook(() => {
  PENDING_DELTAS.clear();
});

let foldApplicationsForTest = 0;
let rebuildApplicationsForTest = 0;

/** Test-only: how many syncs folded buffered deltas vs rebuilt from scratch.
 *  The equivalence property test asserts the fold path actually ran. */
export function transcriptFoldCountersForTest(): {
  readonly folds: number;
  readonly rebuilds: number;
} {
  return {
    folds: foldApplicationsForTest,
    rebuilds: rebuildApplicationsForTest,
  };
}

/** Test-only: drop a stream's fold state so the next sync rebuilds from
 *  scratch — the production resync path, used as the equivalence oracle. */
export function invalidateTranscriptFoldForTest(streamId: StreamTabId): void {
  const fold = streams.get().get(streamId)?.transcriptFold;
  if (fold) resetTranscriptFoldState(fold);
}

/** Test-only: per-stream projection-state occupancy, for eviction-path regression coverage. */
export function streamRenderCacheSizesForTest(): {
  readonly taskGroups: number;
  readonly compaction: number;
  readonly render: number;
} {
  let taskGroups = 0;
  let compaction = 0;
  let render = 0;
  for (const slice of streams.get().values()) {
    const fold = slice.transcriptFold;
    if (fold?.taskGroupProjection) taskGroups += 1;
    if (fold?.compactionProjection) compaction += 1;
    if (fold?.hydrated) render += 1;
  }
  return { taskGroups, compaction, render };
}

// ---------------------------------------------------------------------------
// Subscription + sync entry points
// ---------------------------------------------------------------------------

function trySyncStreamLog(streamId: StreamTabId): void {
  try {
    syncStreamLog(streamId);
  } catch (error) {
    setTransientNotice(
      `Could not update transcript: ${toErrorMessage(error)}`,
      { ttlMs: Number.POSITIVE_INFINITY },
    );
  }
}

export function subscribeStreamLog(): () => void {
  const store = defaultSession().transcripts;
  let previousActiveStreamId = activeStreamId.get();

  // One trailing timer shared by every stream: during a multi-subagent burst
  // the root and each child emit within the same window, and per-stream
  // timers would fire staggered — one sync→render pass per stream. A shared
  // batch window coalesces them into a single pass; each stream's buffered
  // delta is folded when it fires, so batching loses nothing.
  const syncDebounce = createFlushableDebounce(() => {
    for (const [streamId, pending] of [...PENDING_DELTAS]) {
      if (pending.generation !== getCliStateGeneration()) {
        PENDING_DELTAS.delete(streamId);
        continue;
      }
      trySyncStreamLog(streamId);
    }
  }, STREAM_SYNC_THROTTLE_MS);

  const dispose = store.onChange((streamId, delta) => {
    if (isCliStreamRetired(streamId)) return;
    const pending = PENDING_DELTAS.get(streamId);
    if (pending) {
      pending.buffer.push(delta);
      pending.generation = getCliStateGeneration();
    } else {
      const buffer = new StreamLogDeltaBuffer(delta.emissionSeq - 1);
      buffer.push(delta);
      PENDING_DELTAS.set(streamId, {
        buffer,
        generation: getCliStateGeneration(),
      });
    }
    // Only start the window on its first tick — later ticks in the same
    // window join the batch without resetting the countdown (`pending`
    // guard), unlike a classic debounce that would restart on every call.
    if (!syncDebounce.pending) syncDebounce.schedule();
  });

  const disposeFocus = subscribeToSignalChanges([activeStreamId], () => {
    const nextActiveStreamId = activeStreamId.get();
    const previous = previousActiveStreamId;
    previousActiveStreamId = nextActiveStreamId;

    if (previous && previous !== nextActiveStreamId) {
      trySyncStreamLog(previous);
      // Terminal status normally requests eviction immediately. This focus
      // boundary remains a backstop when that status event was not observed.
      releaseInactiveStreamTranscript(previous);
    }
    if (!nextActiveStreamId || nextActiveStreamId === previous) return;

    const generation = getCliStateGeneration();
    void store
      .ensureLoaded(nextActiveStreamId)
      .then(() => {
        if (generation === getCliStateGeneration()) {
          trySyncStreamLog(nextActiveStreamId);
        }
      })
      .catch((error: unknown) => {
        if (activeStreamId.get() === nextActiveStreamId) {
          setTransientNotice(
            `Could not load transcript: ${toErrorMessage(error)}`,
            { ttlMs: Number.POSITIVE_INFINITY },
          );
        }
      });
  });

  return () => {
    dispose();
    disposeFocus();
    // Cancel, not flush: the caller is tearing down (process exit or
    // unmount), so a final render of whatever was still pending isn't
    // needed and would race an already-torn-down UI.
    syncDebounce.cancel();
    PENDING_DELTAS.clear();
  };
}

export function syncStreamLog(
  streamId: StreamTabId,
  options: {
    /** Treat the stream as final for settled-prefix promotion, even when its
     *  status has not reached a settlement phase (turn-boundary callers). */
    readonly forceFinal?: boolean;
  } = {},
): void {
  if (isChildStreamRemoved(streamId)) {
    // Projection state died with the slice (`removeStream`); only the
    // store-delta buffer is keyed outside it.
    PENDING_DELTAS.delete(streamId);
    return;
  }
  // AgentTrace throttles MODEL_RESPONSE chunks into the store via a 50ms
  // timer. If we read before that timer fires (e.g. the stream finalized
  // between two TUI sync ticks), the assistant text is still sitting in
  // an in-memory buffer and never reaches the transcript. Force any
  // pending flushers to materialize before we read — their emissions land
  // in this stream's pending buffer and are folded below.
  const session = defaultSession();
  session.flushPendingTraces();
  const store = session.transcripts;
  const log = store.get(streamId);
  const pending = PENDING_DELTAS.get(streamId);
  PENDING_DELTAS.delete(streamId);
  if (!log) {
    // No resident log (never created, or evicted): nothing to fold, but a
    // turn-boundary caller may still promote rows the slice already holds.
    // Fold continuity is gone either way, so drop any hydrated state; the
    // next rebuild inherits promotion from the slice rows.
    if (options.forceFinal === true) {
      patchStream(streamId, (slice) => {
        const entries = finalizeSettledPrefix(slice.entries, true);
        return entries === slice.entries ? slice : { ...slice, entries };
      });
      const fold = streams.get().get(streamId)?.transcriptFold;
      if (fold) resetTranscriptFoldState(fold);
    }
    return;
  }
  const buffer = pending?.buffer;

  const currentActiveStreamId = activeStreamId.get();
  const projectFullTranscript =
    currentActiveStreamId === undefined || currentActiveStreamId === streamId;

  patchStream(streamId, (slice, lifecycle) => {
    const workflowStream = slice.category === AgentCategory.Workflow;
    const fullLogChild = isFullLogChildStream(slice);
    const workflowOperationalOnly = workflowStream && !fullLogChild;
    const streamSettled = isTranscriptSettlementPhase(lifecycle.status);
    const streamFinal = options.forceFinal === true || streamSettled;
    const state = slice.transcriptFold ?? createTranscriptFoldState();
    const flags = newFoldChangeFlags();
    const modeCurrent =
      state.fullLogChild === fullLogChild &&
      state.workflowOperationalOnly === workflowOperationalOnly &&
      state.projectLifecycleToTaskGroups === workflowStream;
    // Fold continuity: same log instance, and either the buffered burst picks
    // up exactly where the state left off and reaches the log's emission
    // head, or (no buffer) the state already sits at the head. Anything else
    // — fresh state, gap, reset emission, mode flip — rebuilds from scratch.
    const canFold =
      state.hydrated &&
      modeCurrent &&
      state.logInstanceId === log.instanceId &&
      !log.hasUndrainedChanges &&
      (buffer
        ? !buffer.resyncRequired &&
          buffer.baseEmissionSeq === state.emissionSeq &&
          buffer.emissionSeq === log.emissionHead
        : state.emissionSeq === log.emissionHead);

    const ctx: FoldContext = {
      log,
      sliceEntries: slice.entries,
      streamFinal,
      streamSettled,
      flags,
    };
    let projections;
    if (canFold) {
      foldApplicationsForTest += 1;
      const changes = buffer?.drain();
      const appended = changes?.appended ?? [];
      let dirtied = changes?.dirtied ?? [];
      if (changes && changes.textChunks.length > 0) {
        // The fold applies whole entry values, so resolve each text chunk to
        // its entry's current object. Safe: `canFold` pinned the buffer at
        // the log's emission head, so current values are exactly the
        // post-burst state the chunks stream toward. A chunk's id may also
        // be buffered by (older) value; the resolved current value replaces
        // it in place to keep appended/dirtied disjoint by id.
        const appendedIndexById = new Map(
          appended.map((entry, index) => [entry.id, index] as const),
        );
        const dirtiedById = new Map(
          dirtied.map((entry) => [entry.id, entry] as const),
        );
        for (const chunk of changes.textChunks) {
          // `canFold` pinned the log instance and emission head, so a chunk's
          // id always resolves to a live entry. A miss means the fold
          // invariant broke upstream — fail loudly instead of letting
          // `undefined` corrupt the fold state (#9985 review finding).
          const current = log.getById(chunk.id);
          if (!current) {
            throw new Error(
              `Transcript fold invariant violation: text chunk for unknown entry ${chunk.id} in stream ${streamId}`,
            );
          }
          const appendedIndex = appendedIndexById.get(chunk.id);
          if (appendedIndex !== undefined) {
            appended[appendedIndex] = current;
          } else {
            dirtiedById.set(chunk.id, current);
          }
        }
        dirtied = [...dirtiedById.values()].sort((a, b) => a.seqNo - b.seqNo);
      }
      projections = applyStreamChanges(state, appended, dirtied, ctx);
      state.emissionSeq = log.emissionHead;
    } else {
      rebuildApplicationsForTest += 1;
      const inheritRows = state.hydrated
        ? state.items.map((item) => item.rendered)
        : slice.entries;
      const inherit = new Map<string, ConversationEntry>();
      for (const row of inheritRows) {
        if (!row.synthetic) inherit.set(row.id, row);
      }
      resetTranscriptFoldState(state);
      state.fullLogChild = fullLogChild;
      state.workflowOperationalOnly = workflowOperationalOnly;
      state.projectLifecycleToTaskGroups = workflowStream;
      state.logInstanceId = log.instanceId;
      state.emissionSeq = log.emissionHead;
      state.hydrated = true;
      flags.itemsChanged = true;
      flags.compactAffected = true;
      flags.syntheticsChanged = true;
      projections = applyStreamChanges(state, log.getRange(0), [], {
        ...ctx,
        inherit,
      });
    }

    const { taskGroups, compaction } = projections;
    const compactingActive = compaction.blocks.some(
      (block) => block.status === 'running',
    );
    const live = state.liveActivityEntry;
    const thinkingActive =
      live !== undefined &&
      live.messageType === MESSAGE_TYPES.THINKING &&
      logEntryStreamIsRunning(live);

    let activeSkills = slice.activeSkills;
    if (slice.category === AgentCategory.ToolUse && state.activeSkillsEntry) {
      if (state.activeSkillsParsedFor !== state.activeSkillsEntry) {
        const parsed = ActiveSkillsSnapshotSchema.safeParse(
          state.activeSkillsEntry.data,
        );
        state.activeSkills = parsed.success ? parsed.data.skills : [];
        state.activeSkillsParsedFor = state.activeSkillsEntry;
      }
      activeSkills = state.activeSkills;
    }

    // Transcript-derived live status only. `slice.description` is the
    // runtime's own one-liner and is never written from here.
    const latestUserPos = state.latestUserPos;
    const latestInstruction =
      latestUserPos >= 0 ? state.items[latestUserPos].rendered.text : undefined;
    const latestLine = workflowOperationalOnly
      ? (workflowOperationalLatestLine(state.items) ?? slice.latestLine)
      : ((state.latestResponsePos > latestUserPos
          ? state.items[state.latestResponsePos].rendered.text
          : undefined) ??
        latestInstruction ??
        slice.latestLine);

    // A compact workflow keeps only its bounded canonical dashboard rows plus
    // synthetic operational rows; ordinary inactive streams keep synthetic
    // rows only. Each selection is rebuilt only when a change touched it —
    // the change detection comes from the delta, not from re-deriving and
    // deep-comparing the whole projection.
    const outputStale =
      state.lastEntriesOutput !== slice.entries ||
      state.lastOutputFull !== projectFullTranscript;
    let entries: readonly ConversationEntry[] = slice.entries;
    if (projectFullTranscript) {
      if (flags.itemsChanged || outputStale) {
        entries = state.items.map((item) => item.rendered);
      }
    } else if (workflowStream) {
      if (flags.compactAffected || outputStale) {
        entries = compactWorkflowEntries(state.items);
      }
    } else if (flags.syntheticsChanged || outputStale) {
      entries = state.synthetics;
    }
    state.lastOutputFull = projectFullTranscript;
    state.lastEntriesOutput = entries;

    if (
      slice.transcriptFold === state &&
      entries === slice.entries &&
      slice.latestLine === latestLine &&
      slice.thinkingActive === thinkingActive &&
      slice.compactingActive === compactingActive &&
      slice.workflowAttemptId === state.workflowAttemptId &&
      slice.workflowAttemptBoundaryDeclared ===
        state.workflowAttemptBoundaryDeclared &&
      isDeepStrictEqual(slice.activeSkills, activeSkills) &&
      slice.taskGroups === taskGroups
    ) {
      return slice;
    }
    return {
      ...slice,
      transcriptFold: state,
      latestLine,
      entries,
      activeSkills,
      thinkingActive,
      compactingActive,
      workflowAttemptId: state.workflowAttemptId,
      workflowAttemptBoundaryDeclared: state.workflowAttemptBoundaryDeclared,
      taskGroups,
    };
  });

  // Surface stream as active if we don't already have one — handles bare
  // `texra chat` where setActiveStream is the first signal the runtime emits.
  focusStream(streamId, { onlyIfUnset: true });
}

/**
 * Release a background stream's transcript residency at a lifecycle
 * boundary. Two owners call this — the status subscriber when a stream
 * leaves its active phase, and the focus subscriber when focus moves off a
 * stream — never the render/sync path, so a terminal stream always
 * releases rather than only when a sync happens to run for it. A no-op for
 * the active stream, for a stream whose status is unknown or active, and
 * while no stream is focused (every stream then projects the full
 * transcript, exactly the states the old in-sync release also skipped).
 *
 * Alongside the store eviction this drops the stream's projection state:
 * the fold items and the incremental task-group/compaction memos would
 * otherwise keep every entry (and rendered row) of a completed stream
 * alive for the rest of the session. Safe to drop: each projection rebuilds
 * from scratch — through the shared resync path — the next time this
 * stream syncs (e.g. if it's reactivated).
 */
export function releaseInactiveStreamTranscript(streamId: StreamTabId): void {
  const currentActiveStreamId = activeStreamId.get();
  if (
    currentActiveStreamId === undefined ||
    currentActiveStreamId === streamId
  ) {
    return;
  }
  const slice = streams.get().get(streamId);
  if (slice?.status === undefined || isActivePhase(slice.status)) return;
  defaultSession().transcripts.requestEviction(streamId);
  const fold = slice.transcriptFold;
  if (fold) {
    resetTranscriptFoldState(fold);
    fold.taskGroupProjection = undefined;
    fold.compactionProjection = undefined;
  }
}
