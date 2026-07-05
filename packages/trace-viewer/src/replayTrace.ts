import { dispatchMessage } from '@progressView/frontend/messageDispatcher';
import type { MessageHandlerContext } from '@progressView/frontend/messageHandlerTypes';
import type {
  AgentCategory,
  ExecutionId,
  Plan,
  RunUsageMap,
  StreamLogEntry,
  StreamTabId,
  TodoItem,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc/progressViewCommands';
import type { ProgressViewOutboundMessage } from '@shared/schemas/progressView';

/**
 * Structurally matches `TraceDocument` from `@transcript/traceAssembler` —
 * kept as a local shape here rather than importing that type directly so
 * this package doesn't depend on an in-flight sibling PR merging first. The
 * two should be interchangeable field-for-field.
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
  readonly snapshot: {
    readonly todos?: TodoItem[];
    readonly plan?: Plan | null;
    readonly runUsage?: RunUsageMap;
    readonly queuedFollowUps?: string[];
  };
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
  const updateStreams: UpdateStreamsMessage = {
    command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
    streams: [
      {
        name: trace.streamId,
        label: trace.config.agent,
        model: trace.config.model,
        agent: trace.config.agent,
        agentCategory: trace.config.agentCategory,
        creationTimestamp: trace.entries[0]?.timestamp ?? 0,
        executionId: trace.executionId,
        description: trace.meta?.description,
      },
    ],
    activeStream: trace.streamId,
    agentFilter: 'all',
    streamStates: {
      [trace.streamId]: {
        status: 'ready',
        kind: trace.config.agentCategory,
        conversationProgress: { conversationTurns: 0, toolCallCount: 0 },
        activeSubagents: [],
        finishedSubagentCount: 0,
        activeProcesses: [],
        finishedProcessCount: 0,
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
    runUsage: trace.snapshot.runUsage,
    todos: trace.snapshot.todos ?? [],
    plan: trace.snapshot.plan ?? null,
    queuedFollowUps: trace.snapshot.queuedFollowUps ?? [],
  };
  dispatchMessage(syncContent, ctx);
}
