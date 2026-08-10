import type { StreamPhaseState } from '@agent/runtime/StreamStatusService';
import type {
  ActiveStreamId,
  StreamBadgeSnapshot,
} from '@controllers/session/SessionState';
import type {
  ConversationProgress,
  GoalStatus,
  InquiryThreadUpdatedEvent,
  Plan,
  StreamPhase,
  StreamStage,
  StreamSubstate,
  StreamTabId,
  TokenUsageStats,
  TodoItem,
} from '@shared/schemas';

/**
 * Host-renderer notifications from {@link SessionFactApplier}.
 *
 * The shared applier owns fact→state and calls these after mutations. Each host
 * decides delivery policy (Lit: `sendIfActive`, progress debounce, phase-vs-round
 * wire shape; TUI: signals mirror into `cliState`).
 */
export interface SessionRendererPort {
  isAvailable(): boolean;

  dispose(): void;

  onStreamMetadataChanged(
    streamId: StreamTabId,
    options?: {
      streamStates?: Map<StreamTabId, StreamPhaseState>;
      activeStream?: ActiveStreamId;
    },
  ): void;

  onStreamStatusChanged(
    streamId: StreamTabId,
    status: StreamPhase,
    logHead: number,
    lastTimestamp?: number,
    substate?: StreamSubstate,
  ): void;

  onActiveStreamChanged(streamId: ActiveStreamId): void;

  onStreamDescriptionChanged(streamId: StreamTabId, description: string): void;

  /** Explicit parent-edge fact (`setParentStream`). */
  onParentStreamChanged(
    childStreamId: StreamTabId,
    parentStreamId: StreamTabId | null,
  ): void;

  onConversationProgressChanged(
    streamId: StreamTabId,
    progress: ConversationProgress,
  ): void;

  /**
   * Stage slot changed. Lit applies phase→metadata vs round→active-only delivery;
   * other hosts project the slot verbatim.
   */
  onStageChanged(streamId: StreamTabId, stage: StreamStage): void;

  onBadgesChanged(streamId: StreamTabId, badges: StreamBadgeSnapshot): void;

  onFilesChanged(streamId: StreamTabId): void;

  onMissingOutputsChanged(
    streamId: StreamTabId,
    options?: { reset?: boolean },
  ): void;

  onCompileFailuresChanged(streamId: StreamTabId): void;

  onRunUsageChanged(
    streamId: StreamTabId,
    storageKey: string,
    usage: TokenUsageStats,
  ): void;

  onTodosChanged(streamId: StreamTabId, todos: TodoItem[]): void;

  onPlanChanged(streamId: StreamTabId, plan: Plan | null): void;

  onQueuedFollowUpsChanged(streamId: StreamTabId): void;

  onInquiryThreadUpdated(thread: InquiryThreadUpdatedEvent): void;

  onGoalActiveChanged(
    streamId: StreamTabId,
    active: boolean,
    details?: { status?: GoalStatus; objective?: string },
  ): void;

  /** Auto-paused goal — TUI surfaces a transcript notice; Lit no-ops. */
  onGoalPaused(streamId: StreamTabId): void;

  /** Drop buffered conversation-progress pushes for a stream (new RUNNING). */
  clearPendingConversationProgress(streamId: StreamTabId): void;

  /**
   * Full active-viewport rebuild. Lit owns bridge cursor sync + controls packing;
   * TUI no-ops (transcript projection is separate).
   */
  syncStreamContent(
    stream: ActiveStreamId,
    options?: { includeActiveState?: boolean },
  ): void;
}
