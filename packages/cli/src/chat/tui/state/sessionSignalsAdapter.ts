// Project shared session facts into the CLI TUI signal state.

import { isDeepStrictEqual } from 'node:util';

import { RUN_FACT_EVENT_TYPES } from '@agent/trace';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type {
  SessionEventHub,
  SessionFact,
} from '@agent/runtime/SessionEventHub';
import { SessionFactApplier } from '@controllers/session/SessionFactApplier';
import type { SessionRendererPort } from '@controllers/session/SessionRendererPort';
import {
  SessionState,
  type ActiveStreamId,
} from '@controllers/session/SessionState';
import { MemoryStateStore } from '@platform/defaults/memoryState';
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
  getCliStateGeneration,
  patchStream,
  registerCliStateResetHook,
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

/** Extract a stream id from a session fact for per-stream generation capture.
 *  The only fact types that trigger renderer callbacks after an async suspend
 *  are `setActiveStream` and `setParentStream`; other facts are handled
 *  synchronously and the exact id is a best-effort hint. */
function getSessionFactStreamId(fact: SessionFact): StreamTabId | undefined {
  switch (fact.type) {
    case 'status':
      return fact.streamId;
    case 'removeStream':
      return fact.payload.streamId;
    case 'setParentStream':
      return fact.payload.childStreamId;
    default:
      return (fact.payload as { streamId?: StreamTabId })?.streamId;
  }
}

class TuiSessionRenderer implements SessionRendererPort {
  /**
   * Generation snapshots captured per-stream at dispatch time, so a callback
   * can detect that `resetCliState` ran between its dispatch and its
   * invocation (the applier suspends in `handleSetActiveStream` while
   * `streamLogs.ensureLoaded` is pending; the old single-field design let a
   * second dispatch overwrite the captured generation, so the first callback
   * could not tell a reset had happened).
   */
  private dispatchGenerations = new Map<StreamTabId, number>();

  constructor(
    private readonly state: SessionState,
    private readonly snapshots: StreamArtifactReader,
    private readonly session: SessionHandle,
  ) {}

  /** Called by the adapter immediately before each applier dispatch.
   *  Stores the current CLI-state generation keyed by `streamId` so that
   *  the downstream callbacks (which all carry a `streamId`) can compare
   *  against the generation *they* were dispatched with, not a value a
   *  later dispatch may have overwritten. */
  captureDispatchGeneration(streamId: StreamTabId): void {
    this.dispatchGenerations.set(streamId, getCliStateGeneration());
  }

  private isStaleDispatch(streamId: StreamTabId): boolean {
    const captured = this.dispatchGenerations.get(streamId);
    return captured !== undefined && captured !== getCliStateGeneration();
  }

  isAvailable(): boolean {
    return true;
  }

  dispose(): void {}

  clearPendingConversationProgress(_streamId: StreamTabId): void {}

  onStreamMetadataChanged(streamId: StreamTabId): void {
    if (this.isStaleDispatch(streamId)) return;
    if (isChildStreamRemoved(streamId)) return;
    const metadata = this.state.getStreamMetadata(streamId);
    const config = this.state.snapshots.getRunMetadata(streamId).config;
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
      agent: config?.agent ?? identityAgent ?? slice.agent,
      model: config?.model ?? slice.model,
      category:
        metadata.agentCategory ?? config?.agentCategory ?? slice.category,
      ...(config
        ? {
            files: {
              input: config.inputFiles,
              context: config.contextFiles,
              media: config.mediaFiles,
              output: config.outputFiles,
            },
          }
        : {}),
      ...(metadata.description !== undefined
        ? { description: metadata.description }
        : {}),
    }));
  }

  onParentStreamChanged(
    childStreamId: StreamTabId,
    parentStreamId: StreamTabId | null,
  ): void {
    if (this.isStaleDispatch(childStreamId)) return;
    setParentStream(childStreamId, parentStreamId);
  }

  onStreamStatusChanged(
    streamId: StreamTabId,
    status: StreamPhase,
    _logHead: number,
    lastTimestamp?: number,
    substate?: StreamSubstate,
  ): void {
    if (this.isStaleDispatch(streamId)) return;
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

  onActiveStreamChanged(streamId: ActiveStreamId): void {
    if (streamId && this.isStaleDispatch(streamId)) return;
    if (!streamId) {
      activeStreamId.set(undefined);
      return;
    }
    if (isChildStreamRemoved(streamId)) return;
    focusStream(streamId);
  }

  onStreamDescriptionChanged(streamId: StreamTabId, description: string): void {
    if (this.isStaleDispatch(streamId)) return;
    patchStream(streamId, (slice) => ({ ...slice, description }));
  }

  onConversationProgressChanged(
    streamId: StreamTabId,
    progress: ConversationProgress,
  ): void {
    if (this.isStaleDispatch(streamId)) return;
    patchStream(streamId, (slice) => ({ ...slice, conversation: progress }));
  }

  onStageChanged(streamId: StreamTabId, stage: StreamStage): void {
    if (this.isStaleDispatch(streamId)) return;
    patchStream(streamId, (slice) =>
      isDeepStrictEqual(slice.stage, stage) ? slice : { ...slice, stage },
    );
  }

  onBadgesChanged(
    streamId: StreamTabId,
    badges: Parameters<SessionRendererPort['onBadgesChanged']>[1],
  ): void {
    if (this.isStaleDispatch(streamId)) return;
    projectChildRoster(
      streamId,
      badges.subagents.filter((child) => child.finishedAt === undefined),
    );
  }

  onFilesChanged(streamId: StreamTabId): void {
    if (this.isStaleDispatch(streamId)) return;
    patchStream(streamId, (slice) => ({
      ...slice,
      outputFilesByRound: this.snapshots.getOutputFiles(streamId),
    }));
  }

  onMissingOutputsChanged(streamId: StreamTabId): void {
    if (this.isStaleDispatch(streamId)) return;
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
    if (this.isStaleDispatch(streamId)) return;
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
    if (this.isStaleDispatch(streamId)) return;
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
    if (this.isStaleDispatch(streamId)) return;
    patchStream(streamId, (slice) =>
      isDeepStrictEqual(slice.todos, todos) ? slice : { ...slice, todos },
    );
  }

  onPlanChanged(streamId: StreamTabId, plan: Plan | null): void {
    if (this.isStaleDispatch(streamId)) return;
    patchStream(streamId, (slice) =>
      isDeepStrictEqual(slice.plan, plan) ? slice : { ...slice, plan },
    );
  }

  onQueuedFollowUpsChanged(streamId: StreamTabId): void {
    if (this.isStaleDispatch(streamId)) return;
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
    if (this.isStaleDispatch(streamId)) return;
    appendLocalAssistantTranscript(GOAL_PAUSED_TRANSCRIPT_NOTICE, streamId);
  }

  syncStreamContent(
    _stream: ActiveStreamId,
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
  const state = new SessionState(new MemoryStateStore(), session);
  const renderer = new TuiSessionRenderer(state, snapshots, session);
  const applier = new SessionFactApplier(state, renderer, {
    hasPendingPermissions: () => false,
    deleteStream: removeStream,
    // CLI focus is the `activeStreamId` signal, not `SessionState.activeStream`.
    evictOnStreamSwitch: false,
  });
  let generation = getCliStateGeneration();
  const detachResetHook = registerCliStateResetHook(() => {
    generation = getCliStateGeneration();
  });
  const detachSessionFacts = events.subscribeSessionFacts((fact) => {
    if (generation !== getCliStateGeneration()) {
      return;
    }
    // Status stays on `subscribeStreamStatus`: the shared applier's
    // eviction keys off `SessionState.activeStream`, which is not the CLI
    // focus id, and the old TUI ignored status facts here.
    if (fact.type === 'status') return;
    const sessionStreamId = getSessionFactStreamId(fact);
    if (sessionStreamId) renderer.captureDispatchGeneration(sessionStreamId);
    applier.handleSessionFact(fact);
  });
  const detachRunFacts = events.subscribeRunFacts(
    (runFact) => {
      if (
        generation !== getCliStateGeneration() ||
        isChildStreamRemoved(runFact.streamId)
      ) {
        return;
      }
      renderer.captureDispatchGeneration(runFact.streamId);
      applier.handleRunFact(runFact.streamId, runFact.event);
    },
    { types: RUN_FACT_EVENT_TYPES },
  );

  return () => {
    detachResetHook();
    detachRunFacts();
    detachSessionFacts();
    applier.dispose();
  };
}
