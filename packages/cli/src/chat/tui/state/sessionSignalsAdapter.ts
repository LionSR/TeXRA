// Project shared session facts into the CLI TUI signal state.

import { RUN_FACT_EVENT_TYPES } from '@agent/trace';
import type { SessionEventHub, SessionHandle } from '@agent/runtime';
import { SessionFactApplier } from '@controllers/session/SessionFactApplier';
import type {
  PresentedStreamId,
  SessionRendererPort,
} from '@controllers/session/SessionRendererPort';
import { SessionState } from '@controllers/session/SessionState';
import type { StreamArtifactReader } from '@controllers/session/StreamArtifactProjection';
import {
  type ConversationProgress,
  type GoalStatus,
  type InquiryThreadUpdatedEvent,
  type Plan,
  type StreamPhase,
  type StreamStage,
  type StreamSubstate,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import {
  isTerminalOutcomePhase,
  isTranscriptSettlementPhase,
  STREAM_TRANSITION_CAUSE,
} from '@shared/streams/streamStatus';
import {
  activeStreamId,
  focusStream,
  patchStream,
  removeStream,
  setStreamStatusInCliState,
  streams,
} from './cliState';
import {
  bindChildStreamState,
  invalidateChildStreams,
  isChildStreamRemoved,
  unbindChildStreamState,
} from './childExecutions';
import { bumpStreamArtifactRevision } from './subscribeStreamArtifacts';
import {
  releaseInactiveStreamTranscript,
  syncStreamLog,
} from './subscribeStreamLog';
import { appendLocalAssistantTranscript } from './transcript';

const GOAL_PAUSED_TRANSCRIPT_NOTICE =
  'Goal paused after a failed cycle. Review the error before starting a new goal.';

class TuiSessionRenderer implements SessionRendererPort {
  constructor(
    private readonly state: SessionState,
    private readonly snapshots: StreamArtifactReader,
    private readonly session: SessionHandle,
  ) {}

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
    // Attachment (`setActiveStream`) calls `streamLogs.ensureStream` before
    // this notify; mint an empty slice so Tab-children focus works even when
    // no category/config arrived yet. Parent-only edge refreshes do not touch
    // streamLogs, so they stay slice-free here — an edge alone is not
    // focusable until attachment creates the transcript.
    if (this.state.streamLogs.has(streamId) && !streams.get().has(streamId)) {
      patchStream(streamId, (slice) => ({ ...slice }));
    }
  }

  onParentStreamChanged(
    _childStreamId: StreamTabId,
    _parentStreamId: StreamTabId | null,
  ): void {
    // The applier already landed the edge on `SessionState` metadata; the
    // CLI's topology snapshot re-derives from there.
    invalidateChildStreams();
  }

  onStreamStatusChanged(
    streamId: StreamTabId,
    status: StreamPhase,
    _logHead: number,
    lastTimestamp?: number,
    substate?: StreamSubstate,
  ): void {
    setStreamStatusInCliState({
      streamId,
      status,
      substate,
      // Use the backend's last-known timestamp for the stream (from its log
      // entries) rather than Date.now() at render time, so `runStartedAt`
      // reflects a backend timestamp instead of when the TUI received it.
      ...(lastTimestamp !== undefined ? { nowMs: lastTimestamp } : {}),
    });
    // Roster rows carry phase (`recordChildPhase`); re-derive snapshots so
    // child rows repaint on phase flips.
    invalidateChildStreams();
  }

  onActiveStreamChanged(streamId: PresentedStreamId): void {
    if (!streamId) {
      activeStreamId.set(undefined);
      return;
    }
    if (isChildStreamRemoved(streamId)) return;
    focusStream(streamId);
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

  onBadgesChanged(
    _streamId: StreamTabId,
    _badges: Parameters<SessionRendererPort['onBadgesChanged']>[1],
  ): void {
    // The shared applier already landed this roster on `SessionState` — live
    // rows plus the finished children it retains for display (phase-merged,
    // 200-capped). The CLI reads it there; only the snapshots re-derive.
    invalidateChildStreams();
  }

  onFilesChanged(_streamId: StreamTabId): void {
    // Renderers read `StreamArtifactProjection` directly.
    bumpStreamArtifactRevision();
  }

  onMissingOutputsChanged(_streamId: StreamTabId): void {
    // Renderers read `StreamArtifactProjection` directly; a disk-restored
    // clear invalidates the memo like any other change.
    bumpStreamArtifactRevision();
  }

  onCompileFailuresChanged(_streamId: StreamTabId): void {
    // Renderers read `StreamArtifactProjection` directly.
    bumpStreamArtifactRevision();
  }

  onRunUsageChanged(
    streamId: StreamTabId,
    _storageKey: string,
    latestUsage: Parameters<SessionRendererPort['onRunUsageChanged']>[2],
  ): void {
    // The latest-usage gauge is payload-only (no synchronous shared read);
    // the cumulative sum is `StreamArtifactProjection.cumulativeUsage`.
    patchStream(streamId, (slice) => ({ ...slice, usage: latestUsage }));
    bumpStreamArtifactRevision();
  }

  // Live todos/plan are readable from the snapshot store synchronously: a
  // live update is applied to `getWorkPlan` before the stream seeds
  // (StreamSnapshotStore eager-apply overlay), so renderers read the store.
  onTodosChanged(_streamId: StreamTabId, _todos: TodoItem[]): void {
    bumpStreamArtifactRevision();
  }

  onPlanChanged(_streamId: StreamTabId, _plan: Plan | null): void {
    bumpStreamArtifactRevision();
  }

  onQueuedFollowUpsChanged(_streamId: StreamTabId): void {
    // The session-owned queue is the single source; renderers read
    // `queuedFollowUpsFor` at paint.
    invalidateChildStreams();
  }

  onInquiryThreadUpdated(_thread: InquiryThreadUpdatedEvent): void {}

  onGoalActiveChanged(
    _streamId: StreamTabId,
    _active: boolean,
    _details?: { status?: GoalStatus; objective?: string },
  ): void {}

  onGoalPaused(streamId: StreamTabId): void {
    appendLocalAssistantTranscript(GOAL_PAUSED_TRANSCRIPT_NOTICE, streamId);
  }

  syncStreamContent(
    _stream: PresentedStreamId,
    _options?: { includeActiveState?: boolean },
  ): void {}
}

export interface AttachSessionSignalsAdapterInit {
  readonly events: SessionEventHub;
  readonly session: SessionHandle;
  readonly snapshots: StreamArtifactReader;
}

/** Attach the shared session view-model to CLI signals for one TUI session. */
export function attachSessionSignalsAdapter({
  events,
  session,
  snapshots,
}: AttachSessionSignalsAdapterInit): () => void {
  const state = new SessionState(session);
  bindChildStreamState(state);
  const renderer = new TuiSessionRenderer(state, snapshots, session);
  const applier = new SessionFactApplier(state, renderer, {
    // Removal fires no renderer-port callback by design; the CLI is the
    // delete executor in-process, so the roster/tombstone snapshots
    // re-derive here, same-tick with the applier's removal barrier.
    deleteStream: (streamId: StreamTabId) => {
      removeStream(streamId);
      invalidateChildStreams();
    },
  });
  const detachSessionFacts = events.subscribeSessionFacts((fact) => {
    if (fact.type === 'status') {
      // CLI status modality runs BEFORE the shared applier sees the fact:
      // the applier requests transcript eviction for non-active phases, and
      // the final fold must land while the log is still resident. So the
      // slice patch lands first (a reused stream still carrying `WAITING`
      // from the previous turn would otherwise finalize the next run's
      // first chunks early), THEN the log sync folds under the current
      // status, THEN lifecycle releases residency for a stream that just
      // left its active phase.
      const recognized = setStreamStatusInCliState({
        streamId: fact.streamId,
        status: fact.phase,
        substate: fact.substate,
      });
      if (recognized) {
        syncStreamLog(
          fact.streamId,
          isTranscriptSettlementPhase(fact.phase) ? { forceFinal: true } : {},
        );
        releaseInactiveStreamTranscript(fact.streamId);
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
          focusStream(ownerStreamId);
        }
      }
      // Roster phase-merge, tombstone gating, and eviction requests.
      applier.handleSessionFact(fact);
      return;
    }
    applier.handleSessionFact(fact);
    if (fact.type === 'setActiveStream') {
      const streamId = fact.payload.streamId;
      if (!streamId) {
        renderer.onActiveStreamChanged('');
      } else if (fact.payload.suppressViewSwitch !== true) {
        renderer.onActiveStreamChanged(streamId);
      }
    }
  });
  const detachRunFacts = events.subscribeRunFacts(
    (runFact) => {
      if (isChildStreamRemoved(runFact.streamId)) {
        return;
      }
      applier.handleRunFact(runFact.streamId, runFact.event);
    },
    { types: RUN_FACT_EVENT_TYPES },
  );

  return () => {
    detachRunFacts();
    detachSessionFacts();
    applier.dispose();
    unbindChildStreamState(state);
  };
}
