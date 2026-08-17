// Project shared session facts into the CLI TUI signal state.

import { isDeepStrictEqual } from 'node:util';

import { RUN_FACT_EVENT_TYPES } from '@agent/trace';
import type { SessionEventHub, SessionHandle } from '@agent/runtime';
import { SessionFactApplier } from '@controllers/session/SessionFactApplier';
import type {
  PresentedStreamId,
  SessionRendererPort,
} from '@controllers/session/SessionRendererPort';
import { SessionState } from '@controllers/session/SessionState';
import {
  sumUsageStats,
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
  activeStreamId,
  focusStream,
  patchStream,
  removeStream,
  setStreamStatusInCliState,
  streams,
} from './cliState';
import {
  isChildStreamRemoved,
  projectChildRoster,
  setParentStream,
} from './childExecutions';
import { appendLocalAssistantTranscript } from './transcript';
import type { StreamArtifactReader } from './subscribeStreamArtifacts';

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
    if (isChildStreamRemoved(streamId)) return;
    const metadata = this.state.getStreamMetadata(streamId);
    // Display config comes from the always-resident summary mirror, never from
    // a synchronous per-stream sidecar read (#9947). Run input/context/media
    // file lists are no longer surfaced by TUI state at all.
    const config = metadata.config;
    // Parent-only metadata refreshes must not mint a StreamSlice: an edge
    // alone is not focusable until attachment (`setActiveStream`) creates one.
    const hasDisplayFields =
      metadata.identity != null ||
      metadata.userFollowUpSupport != null ||
      metadata.agentCategory != null ||
      metadata.description != null ||
      config != null;
    if (!hasDisplayFields) {
      // Attachment (`setActiveStream`) calls `streamLogs.ensureStream` before
      // this notify; mint an empty slice so Tab-children focus works even
      // when no category/config arrived yet. Parent-only updates do not
      // touch streamLogs, so they stay slice-free here.
      if (this.state.streamLogs.has(streamId) && !streams.get().has(streamId)) {
        patchStream(streamId, (slice) => ({ ...slice }));
      }
      return;
    }
    const identityAgent =
      metadata.identity?.kind === 'agent' ? metadata.identity.agent : undefined;
    patchStream(streamId, (slice) => ({
      ...slice,
      identity: metadata.identity ?? slice.identity,
      userFollowUpSupport: metadata.userFollowUpSupport,
      agent: identityAgent ?? slice.agent,
      model: config?.model ?? slice.model,
      category: metadata.agentCategory ?? slice.category,
      ...(metadata.description !== undefined
        ? { description: metadata.description }
        : {}),
    }));
  }

  onParentStreamChanged(
    childStreamId: StreamTabId,
    parentStreamId: StreamTabId | null,
  ): void {
    setParentStream(childStreamId, parentStreamId);
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
  }

  onActiveStreamChanged(streamId: PresentedStreamId): void {
    if (!streamId) {
      activeStreamId.set(undefined);
      return;
    }
    if (isChildStreamRemoved(streamId)) return;
    focusStream(streamId);
  }

  onStreamDescriptionChanged(streamId: StreamTabId, description: string): void {
    patchStream(streamId, (slice) => ({ ...slice, description }));
  }

  onConversationProgressChanged(
    streamId: StreamTabId,
    progress: ConversationProgress,
  ): void {
    patchStream(streamId, (slice) => ({ ...slice, conversation: progress }));
  }

  onStageChanged(streamId: StreamTabId, stage: StreamStage): void {
    patchStream(streamId, (slice) =>
      isDeepStrictEqual(slice.stage, stage) ? slice : { ...slice, stage },
    );
  }

  onBadgesChanged(
    streamId: StreamTabId,
    badges: Parameters<SessionRendererPort['onBadgesChanged']>[1],
  ): void {
    // The shared applier already computed this roster — live rows plus the
    // finished children it retains for display (phase-merged, 200-capped) —
    // so project it whole; filtering retained rows out here was the
    // #9021-class bug (single-substrate plan, U1). `projectChildRoster`
    // splits by `finishedAt` presence (schema contract): live rows are
    // active membership, retained rows are display history whose membership
    // follows the shared roster (cap evictions included).
    projectChildRoster(streamId, badges.subagents);
  }

  onFilesChanged(streamId: StreamTabId): void {
    patchStream(streamId, (slice) => ({
      ...slice,
      outputFilesByRound: this.snapshots.getOutputFiles(streamId),
    }));
  }

  onMissingOutputsChanged(streamId: StreamTabId): void {
    const missingOutputsByRound = this.snapshots.getMissingOutputs(streamId);
    // `clearMissingOutputs` on a stream with no slice (or an already-empty
    // record) must stay a no-op: calling `patchStream` would mint a slice via
    // the `emptySlice` fallback — and un-retire the id — just to hold an
    // empty record.
    const current = streams.get().get(streamId)?.missingOutputsByRound;
    if (
      Object.keys(missingOutputsByRound).length === 0 &&
      Object.keys(current ?? {}).length === 0
    ) {
      return;
    }
    patchStream(streamId, (slice) => ({ ...slice, missingOutputsByRound }));
  }

  onCompileFailuresChanged(streamId: StreamTabId): void {
    patchStream(streamId, (slice) => ({
      ...slice,
      compileFailuresByRound: this.snapshots.getCompileFailures(streamId),
    }));
  }

  onRunUsageChanged(
    streamId: StreamTabId,
    storageKey: string,
    latestUsage: Parameters<SessionRendererPort['onRunUsageChanged']>[2],
  ): void {
    const runUsage = this.snapshots.getRunUsage(streamId);
    patchStream(streamId, (slice) => ({
      ...slice,
      usage: latestUsage,
      cumulativeUsage: runUsage.has(storageKey)
        ? sumUsageStats([...runUsage.values()])
        : slice.cumulativeUsage,
    }));
  }

  // Live todos/plan use the event payload (same as LitSessionRenderer). The
  // snapshot store may still be queueing the write until a stream is seeded,
  // so getWorkPlan is not a reliable synchronous read here. Disk preload stays
  // on the focus/`/plan` hydration path only.
  onTodosChanged(streamId: StreamTabId, todos: TodoItem[]): void {
    patchStream(streamId, (slice) =>
      isDeepStrictEqual(slice.todos, todos) ? slice : { ...slice, todos },
    );
  }

  onPlanChanged(streamId: StreamTabId, plan: Plan | null): void {
    patchStream(streamId, (slice) =>
      isDeepStrictEqual(slice.plan, plan) ? slice : { ...slice, plan },
    );
  }

  onQueuedFollowUpsChanged(streamId: StreamTabId): void {
    // Prefer the process session queue: tests and production both enqueue
    // there, while a harness may construct a throwaway SessionHandle for the
    // hub alone.
    const messages = this.session.followUps.getAll(streamId);
    patchStream(streamId, (slice) =>
      isDeepStrictEqual(slice.queuedFollowUpMessages, messages)
        ? slice
        : { ...slice, queuedFollowUpMessages: messages },
    );
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
  const renderer = new TuiSessionRenderer(state, snapshots, session);
  const applier = new SessionFactApplier(state, renderer, {
    deleteStream: removeStream,
  });
  const detachSessionFacts = events.subscribeSessionFacts((fact) => {
    // Status stays on `subscribeStreamStatus`: the CLI owns its focus
    // reaction there, while the shared applier only updates session facts and
    // requests lease-aware eviction. The old TUI ignored status facts here.
    if (fact.type === 'status') return;
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
  };
}
