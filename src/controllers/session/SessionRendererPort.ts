import type { StreamPhaseState } from '@agent/runtime/StreamStatusService';
import type { StreamBadgeSnapshot } from '@controllers/session/SessionState';
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

/** A host presentation's focused stream, or no focused stream. */
export type PresentedStreamId = StreamTabId | '';

/**
 * A projection slice whose new value the host re-reads from the shared state
 * rather than receiving on the wire. Each key names the field the host reads
 * (`outputs.files`, `outputs.compileFailures`, `workPlan.queuedFollowUps`,
 * `SessionStreamMetadata.parentStreamId`,
 * `StreamExecutionState.contextState`) or the fact it reacts to
 * (`goalPaused`); nothing here is new vocabulary. Slices whose notification
 * carries real delta semantics — `onMissingOutputsChanged`'s `reset`,
 * `onStageChanged`'s phase-vs-round split — keep their own method.
 */
export type SessionRenderSlice =
  | 'files'
  | 'compileFailures'
  | 'queuedFollowUps'
  | 'parentStreamId'
  | 'contextState'
  | 'goalPaused';

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

  /**
   * A payload-free change on one {@link SessionRenderSlice}: the applier has
   * already landed it on `SessionState`, so the host re-reads the slice it
   * projects. One method instead of a notification per field — the payload was
   * never on the wire, only the field name was.
   */
  invalidate(streamId: StreamTabId, slice: SessionRenderSlice): void;

  onStreamMetadataChanged(
    streamId: StreamTabId,
    options?: {
      streamStates?: Map<StreamTabId, StreamPhaseState>;
      activeStream?: PresentedStreamId;
    },
  ): void;

  onStreamStatusChanged(
    streamId: StreamTabId,
    status: StreamPhase,
    logHead: number,
    lastTimestamp?: number,
    substate?: StreamSubstate,
  ): void;

  onActiveStreamChanged(streamId: PresentedStreamId): void;

  onStreamDescriptionChanged(streamId: StreamTabId, description: string): void;

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

  /** Delta-semantic: `reset` clears the stream's rounds instead of replacing
   *  them, so this one keeps its own envelope rather than folding into
   *  {@link SessionRendererPort.invalidate}. */
  onMissingOutputsChanged(
    streamId: StreamTabId,
    options?: { reset?: boolean },
  ): void;

  onRunUsageChanged(
    streamId: StreamTabId,
    storageKey: string,
    usage: TokenUsageStats,
  ): void;

  onTodosChanged(streamId: StreamTabId, todos: TodoItem[]): void;

  onPlanChanged(streamId: StreamTabId, plan: Plan | null): void;

  onInquiryThreadUpdated(thread: InquiryThreadUpdatedEvent): void;

  onGoalActiveChanged(
    streamId: StreamTabId,
    active: boolean,
    details?: { status?: GoalStatus; objective?: string },
  ): void;

  /** Drop buffered conversation-progress pushes for a stream (new RUNNING). */
  clearPendingConversationProgress(streamId: StreamTabId): void;

  /**
   * Full active-viewport rebuild. Lit owns bridge cursor sync + controls packing;
   * TUI no-ops (transcript projection is separate).
   */
  syncStreamContent(
    stream: PresentedStreamId,
    options?: { includeActiveState?: boolean },
  ): void;
}
