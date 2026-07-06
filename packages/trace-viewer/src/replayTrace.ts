import { dispatchMessage } from '@progressView/frontend/messageDispatcher';
import type { MessageHandlerContext } from '@progressView/frontend/messageHandlerTypes';
import {
  executionStatusToRunOutcome,
  STREAM_STATUS,
  STREAM_LOG_ENTRY_TYPES,
  StreamStatusSchema,
  streamStatusToLifecycleStatus,
  type StreamLifecycleStatus,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc/progressViewCommands';
import type { ProgressViewOutboundMessage } from '@shared/schemas/progressView';
import type { TraceDocument } from '@transcript';
import { isObject } from '@utils/core';

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
 *
 * `terminalStatus` is `null` for traces that predate outcome tracking (or
 * never reached a terminal state). For those legacy traces, derive status from
 * the persisted transcript's last terminal group row before falling back to the
 * older snapshot-status escape hatch. Only when neither source records a
 * terminal status does this default to `READY`, same as an unqualified
 * successful finish.
 */
function toStreamLifecycleStatus(trace: TraceDocument): StreamLifecycleStatus {
  if (trace.terminalStatus !== null) {
    const outcome = executionStatusToRunOutcome(trace.terminalStatus);
    if (outcome) return outcome;
  }
  for (const entry of trace.entries.toReversed()) {
    if (entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_END) continue;
    if (entry.groupId !== undefined) continue;
    if (!isObject(entry.data)) continue;
    const status = StreamStatusSchema.safeParse(entry.data.status);
    if (status.success) return streamStatusToLifecycleStatus(status.data);
  }
  return trace.snapshot.status
    ? streamStatusToLifecycleStatus(trace.snapshot.status)
    : STREAM_STATUS.READY;
}

/**
 * Replays one finished execution through the REAL `dispatchMessage` pipeline
 * as a short synthetic message sequence — the same reducer logic a live host
 * uses, just fed once instead of over time. Order matters: `LOG_DELTA` is a
 * no-op unless `UPDATE_STREAMS` has already registered the stream (see
 * `logSlice.ts`'s `if (!streamState) return`).
 */
export function replayTrace(
  trace: TraceDocument,
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
        status: toStreamLifecycleStatus(trace),
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
