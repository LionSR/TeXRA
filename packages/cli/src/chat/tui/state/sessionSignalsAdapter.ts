// Project shared session facts into the CLI TUI signal state.

import { RUN_FACT_EVENT_TYPES } from '@agent/trace';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { SessionFactApplier } from '@controllers/session/SessionFactApplier';
import type { SessionRunFactEvent } from '@controllers/session/SessionFactApplier';
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
    const config = this.state.snapshots.getRunConfig(streamId);
    // Parent-only metadata refreshes must not mint a StreamSlice: an edge
    // alone is not focusable until attachment (`setActiveStream`) creates one.
    const hasDisplayFields =
      metadata.identity != null ||
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
    patchStream(streamId, (slice) => ({
      ...slice,
      identity: metadata.identity ?? slice.identity,
      agent:
        config?.agent ??
        (metadata.identity?.kind === 'agent'
          ? metadata.identity.agent
          : slice.agent),
      model: config?.model ?? metadata.config?.model ?? slice.model,
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
    setParentStream(childStreamId, parentStreamId);
  }

  onStreamStatusChanged(
    streamId: StreamTabId,
    status: StreamPhase,
    _lastTimestamp?: number,
    substate?: StreamSubstate,
  ): void {
    setStreamStatusInCliState({ streamId, status, substate });
  }

  onActiveStreamChanged(streamId: ActiveStreamId): void {
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
    patchStream(streamId, (slice) => ({ ...slice, stage }));
  }

  onBadgesChanged(
    streamId: StreamTabId,
    badges: Parameters<SessionRendererPort['onBadgesChanged']>[1],
  ): void {
    projectChildRoster(
      streamId,
      badges.subagents.filter((child) => child.finishedAt === undefined),
    );
  }

  onFilesChanged(streamId: StreamTabId): void {
    patchStream(streamId, (slice) => ({
      ...slice,
      outputFilesByRound: this.snapshots.getOutputFiles(streamId),
    }));
  }

  onMissingOutputsChanged(streamId: StreamTabId): void {
    patchStream(streamId, (slice) => ({
      ...slice,
      missingOutputsByRound: this.snapshots.getMissingOutputs(streamId),
    }));
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

  onTodosChanged(streamId: StreamTabId, todos: TodoItem[]): void {
    patchStream(streamId, (slice) => ({ ...slice, todos }));
  }

  onPlanChanged(streamId: StreamTabId, plan: Plan | null): void {
    patchStream(streamId, (slice) => ({ ...slice, plan }));
  }

  onQueuedFollowUpsChanged(streamId: StreamTabId): void {
    // Prefer the process session queue: tests and production both enqueue
    // there, while a harness may construct a throwaway SessionHandle for the
    // hub alone.
    const messages = this.session.followUps.getAll(streamId);
    patchStream(streamId, (slice) => ({
      ...slice,
      queuedFollowUpMessages: messages,
    }));
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
  });
  let generation = getCliStateGeneration();
  const detachResetHook = registerCliStateResetHook(() => {
    generation = getCliStateGeneration();
  });
  const detachSessionFacts = events.subscribe(
    (event) => {
      if (generation !== getCliStateGeneration() || event.scope !== 'session') {
        return;
      }
      applier.handleSessionFact(event.event);
    },
    { scope: 'session' },
  );
  const detachRunFacts = events.subscribe(
    (event) => {
      if (
        generation !== getCliStateGeneration() ||
        event.scope !== 'run' ||
        isChildStreamRemoved(event.streamId)
      ) {
        return;
      }
      applier.handleRunFact(event.streamId, event.event as SessionRunFactEvent);
    },
    { scope: 'run', types: RUN_FACT_EVENT_TYPES },
  );

  return () => {
    detachResetHook();
    detachRunFacts();
    detachSessionFacts();
    applier.dispose();
  };
}
