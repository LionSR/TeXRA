// Local imports - shared schemas
import {
  AGENT_CATEGORY,
  // Message schemas (shared between backend and frontend)
  AddTaskGroupMessageSchema,
  AppendLogMessageSchema,
  DeleteAllMessageSchema,
  DeleteStreamMessageSchema,
  FollowUpTextPolishedMessageSchema,
  FollowUpTextTranscribedMessageSchema,
  RecordingErrorMessageSchema,
  RecordingStartedMessageSchema,
  RecordingStoppedMessageSchema,
  ResolveBashApprovalMessageSchema,
  ResolveAgentProposalMessageSchema,
  ResolveRetryRequestMessageSchema,
  ResolveToolEditApprovalMessageSchema,
  SetFollowupOptionsMessageSchema,
  ShowAgentProposalMessageSchema,
  ShowBashApprovalMessageSchema,
  ShowRetryRequestMessageSchema,
  ShowToolEditApprovalMessageSchema,
  UpdateContextStateMessageSchema,
  UpdateFilesMessageSchema,
  UpdateInstructionMessageSchema,
  UpdateLogMessageSchema,
  UpdateLogsMessageSchema,
  UpdateMissingOutputsMessageSchema,
  UpdateQueuedFollowUpsMessageSchema,
  UpdateRunUsageMessageSchema,
  UpdateStatusMessageSchema,
  UpdateStreamStatusMessageSchema,
  UpdateStreamsMessageSchema,
  UpdateTaskGroupMessageSchema,
  UpdateTodosMessageSchema,
  UpdateToolEditApprovalStateMessageSchema,
  UpdateUsageMessageSchema,
  type InstructionUpdate,
  type LogMessageData,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';

// Local imports - progress view
import type { FollowupOptions } from './components/FollowupSection';
import type { PromptState } from './components/PromptOverlay';
import type { EventHandlerContext } from './eventHandlers';
import {
  createEmptyStreamState,
  getEffectiveRunId,
  getStreamState,
  type ProgressState,
  type StreamFilter,
  type StreamState,
} from './store';
import { updateNestedRounds } from './stateUtils';

/**
 * Stores pending log updates that arrive before their APPEND_LOG.
 * When UPDATE_LOG arrives for a log that doesn't exist yet, we store it here.
 * When APPEND_LOG arrives, we merge any pending update before rendering.
 */
const pendingLogUpdates = new Map<string, Partial<LogMessageData>>();

/**
 * Message types that should auto-expand by default.
 */
const AUTO_EXPAND_MESSAGE_TYPES = new Set(['thinking', 'scratchpad']);

/**
 * Context passed to message handlers. Extends EventHandlerContext with
 * prompt state accessors needed for handling approval/retry messages.
 */
export interface MessageHandlerContext extends EventHandlerContext {
  getPrompts(): PromptState[];
  setPrompts(prompts: PromptState[]): void;
}

function updateStreamInfo(
  state: ProgressState,
  streams: StreamTabInfo[],
): ProgressState {
  const nextStates = new Map(state.streamStates);
  const knownStreams = new Set(streams.map((stream) => stream.name));

  for (const key of nextStates.keys()) {
    if (!knownStreams.has(key)) {
      nextStates.delete(key);
    }
  }

  for (const stream of streams) {
    const existing = nextStates.get(stream.name) ?? createEmptyStreamState();
    nextStates.set(stream.name, { ...existing, info: stream });
  }

  return { ...state, streams, streamStates: nextStates };
}

export function handleUpdateStreams(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateStreamsMessageSchema.safeParse(raw);
  if (!result.success) return;

  const previousState = ctx.getState();
  const previousStreamId = previousState.activeStreamId;
  const activeStream = result.data.activeStream ?? null;
  const updated = updateStreamInfo(previousState, result.data.streams);

  ctx.setState(() => ({
    ...updated,
    activeStreamId: activeStream || null,
    streamFilter: result.data.agentFilter as StreamFilter,
  }));

  // Clear log content when:
  // 1. No active stream (filtered to empty category, or no streams at all)
  // 2. Stream switched (need fresh render from UPDATE_LOGS)
  const isStreamSwitch = activeStream !== previousStreamId;
  if (!activeStream || isStreamSwitch) {
    const logList = ctx.getLogListRef();
    logList?.clear();
  }
}

export function handleUpdateLogs(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateLogsMessageSchema.safeParse(raw);
  if (!result.success) return;

  const { stream, messages, groups, action } = result.data;
  const logList = ctx.getLogListRef();

  if (!stream && action === 'clear') {
    pendingLogUpdates.clear();
    ctx.setState((prev) => ({ ...prev, streamStates: new Map() }));
    logList?.renderLogs({
      streamId: '',
      messages: [],
      groups: [],
      action: 'clear',
      activeRunId: null,
      runInstructions: null,
    });
    return;
  }

  if (!stream) return;

  ctx.setStreamState(stream, (prev) => {
    const next = { ...prev };
    if (action === 'clear') {
      next.logs = [];
      next.taskGroups = [];
    } else {
      next.logs = messages;
      if (groups) {
        next.taskGroups = groups;
      }
    }
    if (result.data.activeRunId !== undefined) {
      next.activeRunId = result.data.activeRunId;
    }
    if (result.data.runInstructions) {
      next.runInstructions = {
        ...next.runInstructions,
        ...result.data.runInstructions,
      };
    }
    if (result.data.runUsage) {
      next.runUsage = { ...next.runUsage, ...result.data.runUsage };
    }
    if (result.data.runFiles) {
      next.runFiles = { ...next.runFiles, ...result.data.runFiles };
    }
    if (result.data.runMissingOutputs) {
      next.runMissingOutputs = {
        ...next.runMissingOutputs,
        ...result.data.runMissingOutputs,
      };
    }
    if (result.data.contextState) {
      next.contextState = result.data.contextState;
    }
    return next;
  });

  const state = ctx.getState();
  if (state.activeStreamId === stream) {
    const streamState = getStreamState(state, stream);
    logList?.setAgentCategory(
      streamState.info?.agentCategory ?? AGENT_CATEGORY.WORKFLOW,
    );
    logList?.renderLogs({
      streamId: stream,
      messages: streamState.logs,
      groups: streamState.taskGroups,
      action: action ?? 'render',
      activeRunId: getEffectiveRunId(streamState),
      runInstructions: streamState.runInstructions,
    });
  }
}

export function handleAppendLog(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = AppendLogMessageSchema.safeParse(raw);
  if (!result.success) return;

  const logId = result.data.logMessage.id;
  const pendingUpdate = logId ? pendingLogUpdates.get(logId) : null;

  // Merge any pending update that arrived before this APPEND_LOG
  const mergedLogMessage = pendingUpdate
    ? { ...result.data.logMessage, ...pendingUpdate }
    : result.data.logMessage;

  if (logId && pendingUpdate) {
    pendingLogUpdates.delete(logId);
  }

  ctx.setStreamState(result.data.stream, (prev) => ({
    ...prev,
    logs: [...prev.logs, mergedLogMessage],
  }));

  if (ctx.getState().activeStreamId === result.data.stream) {
    // Auto-expand thinking and scratchpad messages by default
    const shouldAutoExpand = AUTO_EXPAND_MESSAGE_TYPES.has(
      mergedLogMessage.messageType ?? '',
    );
    ctx.getLogListRef()?.appendLog(mergedLogMessage, {
      defaultOpen: shouldAutoExpand,
    });
  }
}

export function handleUpdateLog(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateLogMessageSchema.safeParse(raw);
  if (!result.success) return;

  const logId = result.data.logMessage.id;
  const state = ctx.getState();
  const streamState = getStreamState(state, result.data.stream);
  const logExists = streamState.logs.some((entry) => entry.id === logId);

  if (!logExists) {
    // Log doesn't exist yet - store update for when APPEND_LOG arrives
    if (logId) {
      const existingUpdate = pendingLogUpdates.get(logId) ?? {};
      pendingLogUpdates.set(logId, {
        ...existingUpdate,
        ...result.data.logMessage,
      });
    }
    return;
  }

  ctx.setStreamState(result.data.stream, (prev) => ({
    ...prev,
    logs: prev.logs.map((entry) =>
      entry.id === result.data.logMessage.id ? result.data.logMessage : entry,
    ),
  }));

  if (state.activeStreamId === result.data.stream) {
    ctx.getLogListRef()?.updateLog(result.data.logMessage);
  }
}

export function handleUpdateStatus(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateStatusMessageSchema.safeParse(raw);
  if (!result.success) return;

  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;

  ctx.setStreamState(streamId, (prev) => ({
    ...prev,
    status: result.data.status,
  }));

  if (result.data.status === 'waiting') {
    ctx.getFollowUpRef()?.focusInput({ scrollIntoView: true });
  }
}

export function handleUpdateStreamStatus(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateStreamStatusMessageSchema.safeParse(raw);
  if (!result.success) return;

  const { stream, status, lastTimestamp } = result.data;
  ctx.setStreamState(stream, (prev) => ({ ...prev, status }));

  ctx.setState((prev) => ({
    ...prev,
    streams: prev.streams.map((item) =>
      item.name === stream
        ? {
            ...item,
            status,
            lastTimestamp: lastTimestamp ?? item.lastTimestamp,
          }
        : item,
    ),
  }));

  if (stream === ctx.getState().activeStreamId && status === 'waiting') {
    ctx.getFollowUpRef()?.focusInput({ scrollIntoView: true });
  }
}

export function handleUpdateFiles(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateFilesMessageSchema.safeParse(raw);
  if (!result.success) return;

  const { stream, ...update } = result.data;
  ctx.setStreamState(stream, (prev) => ({
    ...prev,
    runFiles: updateNestedRounds(prev.runFiles, update),
  }));
}

export function handleUpdateMissingOutputs(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateMissingOutputsMessageSchema.safeParse(raw);
  if (!result.success) return;

  const { stream, ...update } = result.data;
  ctx.setStreamState(stream, (prev) => ({
    ...prev,
    runMissingOutputs: updateNestedRounds(prev.runMissingOutputs, update),
  }));
}

export function handleUpdateInstruction(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateInstructionMessageSchema.safeParse(raw);
  if (!result.success) return;
  if (!result.data.stream) return;

  ctx.setStreamState(result.data.stream, (prev) => {
    const runId = prev.activeRunId ?? 'default';
    const runInstructions = { ...prev.runInstructions };
    if (result.data.instruction) {
      runInstructions[runId] = result.data.instruction as InstructionUpdate;
    } else {
      delete runInstructions[runId];
    }
    return { ...prev, runInstructions };
  });
}

export function handleUpdateQueuedFollowUps(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateQueuedFollowUpsMessageSchema.safeParse(raw);
  if (!result.success) return;

  ctx.setStreamState(result.data.stream, (prev) => ({
    ...prev,
    queuedFollowUps: result.data.messages,
  }));
}

export function handleUpdateRunUsage(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateRunUsageMessageSchema.safeParse(raw);
  if (!result.success) return;

  const { stream, runId, usage } = result.data;
  ctx.setStreamState(stream, (prev) => ({
    ...prev,
    runUsage: { ...prev.runUsage, [runId]: usage },
  }));
}

export function handleUpdateContextState(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateContextStateMessageSchema.safeParse(raw);
  if (!result.success) return;

  ctx.setStreamState(result.data.stream, (prev) => ({
    ...prev,
    contextState: result.data.contextState,
  }));
}

export function handleAddTaskGroup(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = AddTaskGroupMessageSchema.safeParse(raw);
  if (!result.success) return;

  ctx.setStreamState(result.data.stream, (prev) => ({
    ...prev,
    taskGroups: [...prev.taskGroups, result.data.group],
  }));

  if (ctx.getState().activeStreamId === result.data.stream) {
    ctx.getLogListRef()?.addGroup(result.data.group);
  }
}

export function handleUpdateTaskGroup(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateTaskGroupMessageSchema.safeParse(raw);
  if (!result.success) return;

  const { streamId, id, status, endTime } = result.data.update;
  ctx.setStreamState(streamId, (prev) => ({
    ...prev,
    taskGroups: prev.taskGroups.map((group) =>
      group.id === id
        ? {
            ...group,
            status: status ?? group.status,
            endTime: endTime ?? group.endTime,
          }
        : group,
    ),
  }));

  if (ctx.getState().activeStreamId === streamId) {
    ctx.getLogListRef()?.updateGroup({ id, status, endTime });
  }
}

export function handleUpdateTodos(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateTodosMessageSchema.safeParse(raw);
  if (!result.success) return;

  ctx.setStreamState(result.data.stream, (prev) => ({
    ...prev,
    todos: result.data.todos,
  }));
}

export function handleShowToolEditApproval(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = ShowToolEditApprovalMessageSchema.safeParse(raw);
  if (!result.success) return;

  ctx.setPrompts([
    ...ctx.getPrompts(),
    { kind: 'toolEdit', data: result.data.request },
  ]);
}

export function handleResolveToolEditApproval(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = ResolveToolEditApprovalMessageSchema.safeParse(raw);
  if (!result.success) return;

  ctx.setPrompts(
    ctx
      .getPrompts()
      .filter(
        (prompt) =>
          prompt.kind !== 'toolEdit' ||
          prompt.data.requestId !== result.data.requestId,
      ),
  );
}

export function handleUpdateToolEditApprovalState(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateToolEditApprovalStateMessageSchema.safeParse(raw);
  if (!result.success) return;

  ctx.setStreamState(result.data.stream, (prev) => ({
    ...prev,
    toolEditBypass: result.data.bypassActive,
  }));
}

export function handleShowBashApproval(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = ShowBashApprovalMessageSchema.safeParse(raw);
  if (!result.success) return;

  ctx.setPrompts([
    ...ctx.getPrompts(),
    { kind: 'bash', data: result.data.request },
  ]);
}

export function handleResolveBashApproval(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = ResolveBashApprovalMessageSchema.safeParse(raw);
  if (!result.success) return;

  ctx.setPrompts(
    ctx
      .getPrompts()
      .filter(
        (prompt) =>
          prompt.kind !== 'bash' ||
          prompt.data.requestId !== result.data.requestId,
      ),
  );
}

export function handleShowRetryRequest(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = ShowRetryRequestMessageSchema.safeParse(raw);
  if (!result.success) return;

  ctx.setPrompts([
    ...ctx.getPrompts(),
    { kind: 'retry', data: result.data.request },
  ]);
}

export function handleResolveRetryRequest(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = ResolveRetryRequestMessageSchema.safeParse(raw);
  if (!result.success) return;

  ctx.setPrompts(
    ctx
      .getPrompts()
      .filter(
        (prompt) =>
          prompt.kind !== 'retry' ||
          prompt.data.streamId !== result.data.streamId,
      ),
  );
}

export function handleShowAgentProposal(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = ShowAgentProposalMessageSchema.safeParse(raw);
  if (!result.success) return;

  ctx.setPrompts([
    ...ctx.getPrompts(),
    { kind: 'proposal', data: result.data.proposal },
  ]);
}

export function handleResolveAgentProposal(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = ResolveAgentProposalMessageSchema.safeParse(raw);
  if (!result.success) return;

  ctx.setPrompts(
    ctx
      .getPrompts()
      .filter(
        (prompt) =>
          prompt.kind !== 'proposal' ||
          prompt.data.proposalId !== result.data.proposalId,
      ),
  );
}

export function handleFollowUpTextPolished(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = FollowUpTextPolishedMessageSchema.safeParse(raw);
  if (!result.success) return;

  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;

  ctx.setStreamState(streamId, (prev) => ({
    ...prev,
    followUpText: result.data.text,
  }));
  ctx.getFollowUpRef()?.applyPolishedText(result.data.text);
}

export function handleFollowUpTextTranscribed(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = FollowUpTextTranscribedMessageSchema.safeParse(raw);
  if (!result.success) return;

  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;

  ctx.getFollowUpRef()?.insertTranscription(result.data.text);
}

export function handleRecordingStarted(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = RecordingStartedMessageSchema.safeParse(raw);
  if (!result.success) return;

  ctx.getFollowUpRef()?.setRecording(true);
}

export function handleRecordingStopped(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = RecordingStoppedMessageSchema.safeParse(raw);
  if (!result.success) return;

  ctx.getFollowUpRef()?.setRecording(false);
}

export function handleRecordingError(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = RecordingErrorMessageSchema.safeParse(raw);
  if (!result.success) return;

  ctx.getFollowUpRef()?.setRecording(false);
}

export function handleSetFollowupOptions(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = SetFollowupOptionsMessageSchema.safeParse(raw);
  if (!result.success) return;

  const options: FollowupOptions = {
    workflowAgentsHtml: result.data.workflowAgentsHtml ?? '',
    toolUseAgentsHtml: result.data.toolUseAgentsHtml ?? '',
    modelOptionsHtml: result.data.modelOptionsHtml ?? '',
    defaultMergeModel: result.data.defaultMergeModel,
  };

  ctx.setState((prev) => ({ ...prev, followupOptions: options }));
}

export function handleDeleteStream(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = DeleteStreamMessageSchema.safeParse(raw);
  if (!result.success) return;

  const streamId = result.data.stream;
  const state = ctx.getState();

  // Remove stream from states
  const nextStates = new Map(state.streamStates);
  nextStates.delete(streamId);

  // Remove stream from list
  const nextStreams = state.streams.filter((s) => s.name !== streamId);

  // Clear active stream if it was deleted
  const nextActiveStreamId =
    state.activeStreamId === streamId ? null : state.activeStreamId;

  ctx.setState(() => ({
    ...state,
    streams: nextStreams,
    streamStates: nextStates,
    activeStreamId: nextActiveStreamId,
  }));

  // Clear log list if active stream was deleted
  if (state.activeStreamId === streamId) {
    pendingLogUpdates.clear();
    ctx.getLogListRef()?.renderLogs({
      streamId: '',
      messages: [],
      groups: [],
      action: 'clear',
      activeRunId: null,
      runInstructions: null,
    });
  }
}

export function handleDeleteAll(
  _raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = DeleteAllMessageSchema.safeParse(_raw);
  if (!result.success) return;

  pendingLogUpdates.clear();
  ctx.setState((prev) => ({
    ...prev,
    streams: [],
    streamStates: new Map(),
    activeStreamId: null,
  }));

  ctx.getLogListRef()?.renderLogs({
    streamId: '',
    messages: [],
    groups: [],
    action: 'clear',
    activeRunId: null,
    runInstructions: null,
  });
}

export function handleUpdateUsage(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateUsageMessageSchema.safeParse(raw);
  if (!result.success) return;

  const { stream, usage } = result.data;
  ctx.setStreamState(stream, (prev) => ({
    ...prev,
    runUsage: usage,
  }));
}
