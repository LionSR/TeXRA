// Project shared session facts into the CLI TUI signal state.

import { RUN_FACT_EVENT_TYPES } from '@agent/trace';
import type { SessionHandle } from '@agent/runtime';
import { SessionFactApplier } from '@controllers/session/SessionFactApplier';
import type {
  PresentedStreamId,
  SessionRendererPort,
  SessionRenderSlice,
} from '@controllers/session/SessionRendererPort';
import { SessionState } from '@controllers/session/SessionState';
import {
  type ConversationProgress,
  type GoalStatus,
  type InquiryThreadUpdatedEvent,
  type Plan,
  type StreamStage,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { subscribeToSignalChanges } from '@shared/signals';
import {
  isTerminalOutcomePhase,
  isTranscriptSettlementPhase,
  STREAM_TRANSITION_CAUSE,
} from '@shared/streams/streamStatus';
import { assertNever, filterNotNullish } from '@utils/core';
import {
  activeStreamId,
  cliStreamAcceptsStatus,
  foregroundReader,
  patchStream,
  removeStream,
  streams,
} from './cliState';
import {
  bindChildStreamState,
  invalidateChildStreams,
  isChildStreamRemoved,
  unbindChildStreamState,
} from './childExecutions';
import { presentStream } from './childControls';
import { bumpStreamArtifactRevision } from './subscribeStreamArtifacts';
import {
  foregroundReaderStreamId,
  releaseInactiveStreamTranscript,
  syncStreamLog,
} from './subscribeStreamLog';
import { appendLocalAssistantTranscript } from './transcript';

const GOAL_PAUSED_TRANSCRIPT_NOTICE =
  'Goal paused after a failed cycle. Review the error before starting a new goal.';

class TuiSessionRenderer implements SessionRendererPort {
  constructor(private readonly state: SessionState) {}

  isAvailable(): boolean {
    return true;
  }

  dispose(): void {}

  clearPendingConversationProgress(_streamId: StreamTabId): void {}

  onStreamMetadataChanged(streamId: StreamTabId): void {
    // Metadata, description, config, and the per-run reset (a new RUNNING
    // drops retained children and surfaces only here) all live on the shared
    // state; renderers re-read it. No mirror — `SessionState` is the display
    // authority (#9947: config comes from the always-resident summary mirror).
    invalidateChildStreams();
    if (isChildStreamRemoved(streamId)) return;
    // The existence fact (`run.start`) calls `streamLogs.ensureStream`
    // before this notify; mint an empty slice so Tab-children focus works
    // even when no category/config arrived yet. Parent-only edge refreshes
    // do not touch streamLogs, so they stay slice-free here: an edge alone
    // is not focusable until `run.start` creates the transcript.
    if (this.state.streamLogs.has(streamId) && !streams.get().has(streamId)) {
      patchStream(streamId, (slice) => ({ ...slice }));
    }
  }

  invalidate(streamId: StreamTabId, slice: SessionRenderSlice): void {
    switch (slice) {
      case 'files':
      case 'compileFailures':
      case 'missingOutputs':
        // Renderers read `StreamArtifactProjection` directly, and the store
        // already accepted this write (eagerly, ahead of any seed), so it is
        // the store that reports the record has provenance — a live fact
        // never waits on the focus-driven disk preload that exists only to
        // seed a stream cold. Only the repaint is owed here.
        return bumpStreamArtifactRevision();
      case 'parentStreamId':
      case 'queuedFollowUps':
      case 'contextState':
      case 'subagents':
        // The applier already landed the edge / the session-owned queue /
        // the model handler's context snapshot / the child-activity roster
        // on `SessionState`; the CLI's topology snapshot, `queuedFollowUpsFor`,
        // and the status bar's `streamStateFor` read re-derive from there at
        // paint.
        return invalidateChildStreams();
      case 'goalPaused':
        return appendLocalAssistantTranscript(
          GOAL_PAUSED_TRANSCRIPT_NOTICE,
          streamId,
        );
    }
    assertNever(slice, 'Unhandled session render slice');
  }

  onStreamStatusChanged(): void {
    // The status machine already holds this transition — it writes its entry
    // before publishing the fact — and `streamPhaseFor` reads it at paint, so
    // there is nothing to re-apply. Bump the shared revision so the phase,
    // substate, run-window start, and the roster rows that carry phase
    // (`recordChildPhase`) all repaint.
    invalidateChildStreams();
  }

  onActiveStreamChanged(streamId: PresentedStreamId): void {
    if (!streamId) {
      activeStreamId.set(undefined);
      return;
    }
    if (isChildStreamRemoved(streamId)) return;
    presentStream(streamId);
  }

  onStreamDescriptionChanged(
    _streamId: StreamTabId,
    _description: string,
  ): void {
    // `SessionState` metadata owns the description; renderers re-read it.
    invalidateChildStreams();
  }

  onConversationProgressChanged(
    _streamId: StreamTabId,
    _progress: ConversationProgress,
  ): void {
    // `StreamExecutionState.conversationProgress` is written by the applier
    // before this callback; renderers re-read it.
    invalidateChildStreams();
  }

  onStageChanged(_streamId: StreamTabId, _stage: StreamStage): void {
    // `StreamExecutionState.stage` is written by the applier before this
    // callback; renderers re-read it.
    invalidateChildStreams();
  }

  onRunUsageChanged(): void {
    // The store accumulated this delta before the callback; every usage
    // reader projects `StreamArtifactProjection.cumulativeUsage` from it. See
    // `invalidate` for why only the repaint is owed here.
    bumpStreamArtifactRevision();
  }

  // Live todos/plan are readable from the snapshot store synchronously: a
  // live update is applied to `getWorkPlan` before the stream seeds
  // (StreamSnapshotStore eager-apply overlay), so renderers read the store —
  // including `workPlanProvenance`, which the same overlay establishes. Only
  // the repaint is owed here.
  onTodosChanged(_streamId: StreamTabId, _todos: TodoItem[]): void {
    bumpStreamArtifactRevision();
  }

  onPlanChanged(_streamId: StreamTabId, _plan: Plan | null): void {
    bumpStreamArtifactRevision();
  }

  onInquiryThreadUpdated(_thread: InquiryThreadUpdatedEvent): void {}

  onGoalActiveChanged(
    _streamId: StreamTabId,
    _active: boolean,
    _details?: { status?: GoalStatus; objective?: string },
  ): void {}
}

/** Attach the shared session view-model to CLI signals for one TUI session. */
export function attachSessionSignalsAdapter(
  session: SessionHandle,
): () => void {
  const state = new SessionState(session);
  bindChildStreamState(state);
  const renderer = new TuiSessionRenderer(state);
  const applier = new SessionFactApplier(state, renderer, {
    // The shared applier pushes any roster changes through the renderer. The
    // CLI is also the delete executor in-process, so refresh tombstone-derived
    // topology here in the same tick as the removal barrier.
    deleteStream: (streamId: StreamTabId) => {
      removeStream(streamId);
      invalidateChildStreams();
    },
    // Sidecar residency answers to every reader kind, not just the
    // transcript-shaped ones: `/plan` reads the snapshot store directly.
    isStreamPresented: (streamId) =>
      activeStreamId.get() === streamId ||
      foregroundReaderStreamId() === streamId,
  });
  // One owner of "this stream stopped being presented": focus moving, a
  // reader of any kind closing or retargeting, or both at once. The applier's
  // rule decides what that means for the record (a terminal child nothing
  // presents), so a WAITING child the agent is still driving keeps its
  // sidecar while `ExecutionsTool` reads its work plan.
  const presentedStreamIds = (): StreamTabId[] =>
    [activeStreamId.get(), foregroundReaderStreamId()].filter(filterNotNullish);
  let presentedBefore = presentedStreamIds();
  const detachPresentation = subscribeToSignalChanges(
    [activeStreamId, foregroundReader],
    () => {
      const presentedNow = presentedStreamIds();
      for (const streamId of presentedBefore) {
        if (presentedNow.includes(streamId)) continue;
        applier.retireSidecarIfFinishedChild(streamId);
      }
      presentedBefore = presentedNow;
    },
  );

  const detachSessionFacts = session.events.subscribeSessionFacts((fact) => {
    if (fact.type === 'status') {
      // CLI status modality runs BEFORE the shared applier sees the fact:
      // the applier requests transcript eviction for non-active phases, and
      // the final fold must land while the log is still resident. The status
      // machine already holds this phase (it writes before publishing), so
      // the fold below reads the new status through `streamPhaseFor`, THEN
      // lifecycle releases residency for a stream that just left its active
      // phase.
      if (cliStreamAcceptsStatus(fact.streamId)) {
        syncStreamLog(
          session,
          fact.streamId,
          isTranscriptSettlementPhase(fact.phase) ? { forceFinal: true } : {},
        );
        releaseInactiveStreamTranscript(session.transcripts, fact.streamId);
      }
      // A completed or user-stopped child returns manual focus to that
      // child's immediate owner. WAITING, repair events, unrelated streams,
      // and detached children deliberately leave focus unchanged.
      if (
        (fact.cause === STREAM_TRANSITION_CAUSE.LIFECYCLE ||
          fact.cause === STREAM_TRANSITION_CAUSE.USER_STOP) &&
        isTerminalOutcomePhase(fact.phase) &&
        activeStreamId.get() === fact.streamId
      ) {
        const ownerStreamId = state.getStreamMetadata(
          fact.streamId,
        ).parentStreamId;
        if (ownerStreamId && !state.isStreamRemoved(ownerStreamId)) {
          presentStream(ownerStreamId);
        }
      }
    }
    // Roster phase-merge, tombstone gating, and eviction requests.
    applier.handleSessionFact(fact);
  });
  const detachRunFacts = session.events.subscribeRunFacts(
    (runFact) => {
      if (isChildStreamRemoved(runFact.streamId)) {
        return;
      }
      applier.handleRunFact(runFact.streamId, runFact.event);
    },
    { types: RUN_FACT_EVENT_TYPES },
  );

  return () => {
    detachPresentation();
    detachRunFacts();
    detachSessionFacts();
    applier.dispose();
    unbindChildStreamState(state);
  };
}
