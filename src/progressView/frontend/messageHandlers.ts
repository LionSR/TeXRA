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
import {
  createEmptyStreamState,
  getEffectiveRunId,
  getStreamState,
  isToolUseState,
  isWorkflowState,
  type ProgressState,
  type StreamState,
} from './store';
import {
  prependInstructionForToolUse,
  resolveActiveRunId,
  updateNestedRounds,
  updateToolUseState,
  updateWorkflowState,
} from './stateUtils';
import type { PromptState } from './components/PromptOverlay';
import type { FrontendEventHandlerContext } from './eventHandlers';

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
 * Context passed to message handlers. Extends FrontendEventHandlerContext with
 * prompt state accessors needed for handling approval/retry messages.
 */
export interface MessageHandlerContext extends FrontendEventHandlerContext {
  getPrompts(): PromptState[];
  setPrompts(prompts: PromptState[]): void;
}

/**
 * Type for message handler functions.
 * All handlers take raw message data and a context object.
 */
export type MessageHandler = (raw: unknown, ctx: MessageHandlerContext) => void;

/** Add a prompt to the prompt list. */
function addPrompt(ctx: MessageHandlerContext, prompt: PromptState): void {
  ctx.setPrompts([...ctx.getPrompts(), prompt]);
}

/** Remove a prompt by kind and ID field. */
function removePrompt(
  ctx: MessageHandlerContext,
  kind: PromptState['kind'],
  idField: string,
  idValue: string,
): void {
  ctx.setPrompts(
    ctx.getPrompts().filter((p) => {
      if (p.kind !== kind) return true;
      const data = p.data as Record<string, unknown>;
      return data[idField] !== idValue;
    }),
  );
}

function updateStreamInfo(
  state: ProgressState,
  streams: StreamTabInfo[],
  backendStates?: Record<string, unknown>,
): ProgressState {
  const nextStates = new Map(state.streamStates);
  const knownStreams = new Set(streams.map((stream) => stream.name));

  // Remove states for streams that no longer exist
  for (const key of nextStates.keys()) {
    if (!knownStreams.has(key)) {
      nextStates.delete(key);
    }
  }

  for (const stream of streams) {
    // Use backend state if provided (source of truth), otherwise create/update locally
    const backendState = backendStates?.[stream.name] as
      | StreamState
      | undefined;
    if (backendState) {
      // Backend provides discriminated state - use it directly with info
      nextStates.set(stream.name, { ...backendState, info: stream });
    } else {
      // Fallback: create state locally (for backwards compatibility)
      const existing =
        nextStates.get(stream.name) ??
        createEmptyStreamState(stream.agentCategory);
      nextStates.set(stream.name, { ...existing, info: stream });
    }
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
  // Use backend-provided stream states (source of truth) when available
  const backendStates = result.data.streamStates as
    | Record<string, unknown>
    | undefined;
  const updated = updateStreamInfo(
    previousState,
    result.data.streams,
    backendStates,
  );

  ctx.setState(() => ({
    ...updated,
    activeStreamId: activeStream || null,
    streamFilter: result.data.agentFilter,
  }));
}

export function handleUpdateLogs(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateLogsMessageSchema.safeParse(raw);
  if (!result.success) return;

  const { stream, messages, groups, action } = result.data;

  if (!stream && action === 'clear') {
    pendingLogUpdates.clear();
    ctx.setState((prev) => ({ ...prev, streamStates: new Map() }));
    return;
  }

  if (!stream) return;

  ctx.setStreamState(stream, (prev) => {
    const isClear = action === 'clear';
    const {
      activeRunId,
      runInstructions,
      runUsage,
      runFiles,
      runMissingOutputs,
      contextState,
    } = result.data;

    // For tool-use streams, prepend instruction as first userMessage if needed
    let processedMessages = isClear ? [] : messages;
    if (!isClear && isToolUseState(prev) && runInstructions) {
      processedMessages = prependInstructionForToolUse(
        [...messages],
        runInstructions,
        stream,
      );
    }

    // Base fields shared by all stream types
    const baseUpdate = {
      ...prev,
      logs: processedMessages,
      taskGroups: isClear ? [] : (groups ?? prev.taskGroups),
      contextState: contextState ?? prev.contextState,
    };

    // Workflow-specific fields only apply to workflow streams
    if (isWorkflowState(prev)) {
      return {
        ...baseUpdate,
        activeRunId: activeRunId ?? prev.activeRunId,
        runInstructions: runInstructions
          ? { ...prev.runInstructions, ...runInstructions }
          : prev.runInstructions,
        runUsage: runUsage ? { ...prev.runUsage, ...runUsage } : prev.runUsage,
        runFiles: runFiles ? { ...prev.runFiles, ...runFiles } : prev.runFiles,
        runMissingOutputs: runMissingOutputs
          ? { ...prev.runMissingOutputs, ...runMissingOutputs }
          : prev.runMissingOutputs,
      };
    }

    return baseUpdate;
  });
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
    // Trigger focus on follow-up input when entering waiting state (Lit-native)
    ...(result.data.status === 'waiting' ? { shouldFocusFollowUp: true } : {}),
  }));
}

export function handleUpdateStreamStatus(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateStreamStatusMessageSchema.safeParse(raw);
  if (!result.success) return;

  const { stream, status, lastTimestamp } = result.data;
  const isActiveStream = stream === ctx.getState().activeStreamId;

  ctx.setStreamState(stream, (prev) => ({
    ...prev,
    status,
    // Trigger focus on follow-up input when entering waiting state (Lit-native)
    ...(isActiveStream && status === 'waiting'
      ? { shouldFocusFollowUp: true }
      : {}),
  }));

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
}

export function handleUpdateFiles(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateFilesMessageSchema.safeParse(raw);
  if (!result.success) return;

  const { stream, ...update } = result.data;
  updateWorkflowState(ctx, stream, (prev) => ({
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
  updateWorkflowState(ctx, stream, (prev) => ({
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

  const { stream, instruction } = result.data;
  if (!stream) return;

  updateWorkflowState(ctx, stream, (prev) => {
    const runId = resolveActiveRunId(prev) ?? 'default';
    const { [runId]: _, ...rest } = prev.runInstructions;
    return {
      ...prev,
      runInstructions: instruction ? { ...rest, [runId]: instruction } : rest,
    };
  });
}

export function handleUpdateQueuedFollowUps(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateQueuedFollowUpsMessageSchema.safeParse(raw);
  if (!result.success) return;

  updateToolUseState(ctx, result.data.stream, (prev) => ({
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
  updateWorkflowState(ctx, stream, (prev) => ({
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
}

export function handleUpdateTodos(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateTodosMessageSchema.safeParse(raw);
  if (!result.success) return;

  updateToolUseState(ctx, result.data.stream, (prev) => ({
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
  addPrompt(ctx, { kind: 'toolEdit', data: result.data.request });
}

export function handleResolveToolEditApproval(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = ResolveToolEditApprovalMessageSchema.safeParse(raw);
  if (!result.success) return;
  removePrompt(ctx, 'toolEdit', 'requestId', result.data.requestId);
}

export function handleUpdateToolEditApprovalState(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateToolEditApprovalStateMessageSchema.safeParse(raw);
  if (!result.success) return;

  updateToolUseState(ctx, result.data.stream, (prev) => ({
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
  addPrompt(ctx, { kind: 'bash', data: result.data.request });
}

export function handleResolveBashApproval(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = ResolveBashApprovalMessageSchema.safeParse(raw);
  if (!result.success) return;
  removePrompt(ctx, 'bash', 'requestId', result.data.requestId);
}

export function handleShowRetryRequest(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = ShowRetryRequestMessageSchema.safeParse(raw);
  if (!result.success) return;
  addPrompt(ctx, { kind: 'retry', data: result.data.request });
}

export function handleResolveRetryRequest(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = ResolveRetryRequestMessageSchema.safeParse(raw);
  if (!result.success) return;
  removePrompt(ctx, 'retry', 'streamId', result.data.streamId);
}

export function handleShowAgentProposal(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = ShowAgentProposalMessageSchema.safeParse(raw);
  if (!result.success) return;
  addPrompt(ctx, { kind: 'proposal', data: result.data.proposal });
}

export function handleResolveAgentProposal(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = ResolveAgentProposalMessageSchema.safeParse(raw);
  if (!result.success) return;
  removePrompt(ctx, 'proposal', 'proposalId', result.data.proposalId);
}

export function handleFollowUpTextPolished(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = FollowUpTextPolishedMessageSchema.safeParse(raw);
  if (!result.success) return;

  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;

  // Use reactive property to trigger polish application (Lit-native Phase 9e)
  updateToolUseState(ctx, streamId, (prev) => ({
    ...prev,
    followUpText: result.data.text,
    polishedText: result.data.text,
    shouldFocusFollowUp: true,
  }));
}

export function handleFollowUpTextTranscribed(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = FollowUpTextTranscribedMessageSchema.safeParse(raw);
  if (!result.success) return;

  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;

  // Use reactive property to trigger transcription insert (Lit-native Phase 9e)
  updateToolUseState(ctx, streamId, (prev) => ({
    ...prev,
    transcribedText: result.data.text,
    shouldFocusFollowUp: true,
  }));
}

export function handleRecordingStarted(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = RecordingStartedMessageSchema.safeParse(raw);
  if (!result.success) return;

  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;

  // Use reactive property to set recording state (Lit-native Phase 9e)
  updateToolUseState(ctx, streamId, (prev) => ({
    ...prev,
    recording: true,
  }));
}

export function handleRecordingStopped(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = RecordingStoppedMessageSchema.safeParse(raw);
  if (!result.success) return;

  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;

  // Use reactive property to clear recording state (Lit-native Phase 9e)
  updateToolUseState(ctx, streamId, (prev) => ({
    ...prev,
    recording: false,
  }));
}

export function handleRecordingError(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = RecordingErrorMessageSchema.safeParse(raw);
  if (!result.success) return;

  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;

  // Use reactive property to clear recording state (Lit-native Phase 9e)
  updateToolUseState(ctx, streamId, (prev) => ({
    ...prev,
    recording: false,
  }));
}

export function handleSetFollowupOptions(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = SetFollowupOptionsMessageSchema.safeParse(raw);
  if (!result.success) return;

  // Destructure parsed data, providing defaults for optional HTML strings
  const {
    command: _command,
    workflowAgentsHtml = '',
    toolUseAgentsHtml = '',
    modelOptionsHtml = '',
    defaultMergeModel,
  } = result.data;

  ctx.setState((prev) => ({
    ...prev,
    followupOptions: {
      workflowAgentsHtml,
      toolUseAgentsHtml,
      modelOptionsHtml,
      defaultMergeModel,
    },
  }));
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

  // Clear pending updates if active stream was deleted
  if (state.activeStreamId === streamId) {
    pendingLogUpdates.clear();
  }

  ctx.setState(() => ({
    ...state,
    streams: nextStreams,
    streamStates: nextStates,
    activeStreamId: nextActiveStreamId,
  }));
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
}

export function handleUpdateUsage(
  raw: unknown,
  ctx: MessageHandlerContext,
): void {
  const result = UpdateUsageMessageSchema.safeParse(raw);
  if (!result.success) return;

  const { stream, usage } = result.data;
  updateWorkflowState(ctx, stream, (prev) => ({
    ...prev,
    runUsage: usage,
  }));
}
