import { dispatchMessage } from '@progressView/frontend/messageDispatcher';
import type { MessageHandlerContext } from '@progressView/frontend/messageHandlerTypes';
import {
  executionStatusToRunOutcome,
  STREAM_STATUS,
  type AgentCategory,
  type ExecutionId,
  type ExecutionStatus,
  type StreamLifecycleStatus,
  type StreamLogEntry,
  type StreamSnapshot,
  type StreamTabId,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc/progressViewCommands';
import type { ProgressViewOutboundMessage } from '@shared/schemas/progressView';

/**
 * Structurally matches `TraceDocument` from `@transcript/traceAssembler` —
 * kept as a local shape here rather than importing that type directly so
 * this package doesn't depend on an in-flight sibling PR merging first. The
 * two should be interchangeable field-for-field. `snapshot` reuses the real
 * `StreamSnapshot` shared type directly (not a hand-rolled subset) since it's
 * a stable, already-merged schema — narrowing it locally previously dropped
 * the workflow output-file/compile-failure fields silently.
 */
export interface ReplayableTrace {
  readonly executionId: ExecutionId;
  readonly streamId: StreamTabId;
  readonly config: {
    readonly agent: string;
    readonly model: string;
    readonly agentCategory: AgentCategory;
  };
  readonly meta: { readonly description?: string } | null;
  readonly entries: StreamLogEntry[];
  readonly snapshot: StreamSnapshot;
  /** `null` when the execution predates outcome tracking or never reached a terminal state. */
  readonly terminalStatus: ExecutionStatus | null;
}

type UpdateStreamsMessage = Extract<
  ProgressViewOutboundMessage,
  { command: typeof PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS }
>;
type LogDeltaMessage = Extract<
  ProgressViewOutboundMessage,
  { command: typeof PROGRESS_VIEW_COMMANDS.LOG_DELTA }
>;
type SyncStreamContentMessage = Extract<
  ProgressViewOutboundMessage,
  { command: typeof PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT }
>;

/**
 * Maps the persisted-history `ExecutionStatus` onto the `StreamLifecycleStatus`
 * vocabulary `StreamMetadataSchema.status` renders. `executionStatusToRunOutcome`
 * is the sanctioned inverse of `runOutcomeToExecutionStatus` — its `RunOutcome`
 * result (`completed`/`cancelled`/`failed`) is structurally identical to
 * `StreamPhase`'s values, so it's already a valid `StreamLifecycleStatus`.
 * `null` (predates outcome tracking) defaults to `READY`, same as an
 * unqualified successful finish.
 */
function toStreamLifecycleStatus(
  terminalStatus: ExecutionStatus | null,
): StreamLifecycleStatus {
  const outcome = executionStatusToRunOutcome(terminalStatus ?? undefined);
  return outcome ?? STREAM_STATUS.READY;
}

/**
 * Replays one finished execution through the REAL `dispatchMessage` pipeline
 * as a short synthetic message sequence — the same reducer logic a live host
 * uses, just fed once instead of over time. Order matters: `LOG_DELTA` is a
 * no-op unless `UPDATE_STREAMS` has already registered the stream (see
 * `logSlice.ts`'s `if (!streamState) return`).
 */
export function replayTrace(
  trace: ReplayableTrace,
  ctx: MessageHandlerContext,
): void {
  const { snapshot } = trace;
  const updateStreams: UpdateStreamsMessage = {
    command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
    streams: [
      {
        name: trace.streamId,
        label: trace.config.agent,
        model: trace.config.model,
        agent: trace.config.agent,
        agentCategory: trace.config.agentCategory,
        // Empty-entries traces have nothing to derive a creation time from;
        // fall back to "now" rather than the Unix epoch, which would render
        // as a misleadingly specific (and wrong) 1970 date.
        creationTimestamp: trace.entries[0]?.timestamp ?? Date.now(),
        executionId: trace.executionId,
        description: trace.meta?.description,
      },
    ],
    activeStream: trace.streamId,
    agentFilter: 'all',
    streamStates: {
      [trace.streamId]: {
        status: toStreamLifecycleStatus(trace.terminalStatus),
        kind: trace.config.agentCategory,
        conversationProgress: snapshot.conversationProgress,
        // Liveness is never restored as live (matches the existing
        // ghost-stream hydrate convention documented on StreamSnapshot) —
        // an archived trace has no in-flight children regardless of what a
        // stale snapshot recorded.
        activeSubagents: [],
        finishedSubagentCount: snapshot.finishedSubagentCount,
        activeProcesses: [],
        finishedProcessCount: snapshot.finishedProcessCount,
      },
    },
  };
  dispatchMessage(updateStreams, ctx);

  const logDelta: LogDeltaMessage = {
    command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
    streamId: trace.streamId,
    entries: trace.entries,
    updates: [],
    textDeltas: [],
  };
  dispatchMessage(logDelta, ctx);

  const syncContent: SyncStreamContentMessage = {
    command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
    stream: trace.streamId,
    runUsage: snapshot.runUsage,
    todos: snapshot.todos,
    plan: snapshot.plan,
    queuedFollowUps: [],
    // Workflow-only display fields (empty records/arrays for tool-use
    // traces) — the same rename the desktop ghost-stream restore path uses
    // (packages/desktop/src/main/desktopProgressEventBridge.ts).
    workflowFiles: snapshot.outputFilesByRound,
    workflowMissingOutputs: snapshot.missingOutputsByRound,
    workflowCompileFailures: snapshot.compileFailuresByRound,
  };
  dispatchMessage(syncContent, ctx);
}
