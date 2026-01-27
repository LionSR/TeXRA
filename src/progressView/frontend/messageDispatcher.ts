/**
 * Schema-driven message dispatcher for ProgressView.
 *
 * Uses Zod's discriminated union to parse messages once, then dispatches
 * to type-safe handlers. Eliminates boilerplate safeParse calls in handlers.
 *
 * @example
 * // In ProgressApp.handleMessage:
 * dispatchMessage(raw, ctx);
 */

// External imports
import {
  createStreamState,
  ProgressViewOutboundMessageSchema,
  type LogMessageData,
  type ProgressViewOutboundMessage,
  type StreamTabInfo,
} from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view
import {
  updateToolUseState,
  updateWorkflowState,
  updateNestedRounds,
  resolveActiveRunId,
  prependInstructionForToolUse,
} from './stateUtils';
import {
  getStreamState,
  isToolUseState,
  isWorkflowState,
  type ProgressState,
  type StreamState,
} from './store';
import type { FrontendEventHandlerContext } from './eventHandlers';
import type { PermissionState } from './components/PermissionCard';

// ============================================================
// Types
// ============================================================

/**
 * Context passed to message handlers. Extends FrontendEventHandlerContext with
 * prompt state accessors needed for handling approval/retry messages.
 */
export interface MessageHandlerContext extends FrontendEventHandlerContext {
  getPermissions(): PermissionState[];
  setPermissions(permissions: PermissionState[]): void;
}

// ============================================================
// Internal state for pending log updates
// ============================================================

/**
 * Stores pending log updates that arrive before their APPEND_LOG.
 * When UPDATE_LOG arrives for a log that doesn't exist yet, we store it here.
 * When APPEND_LOG arrives, we merge any pending update before rendering.
 */
const pendingLogUpdates = new Map<string, Partial<LogMessageData>>();

// ============================================================
// Helper functions
// ============================================================

function addPermission(
  ctx: MessageHandlerContext,
  permission: PermissionState,
): void {
  ctx.setPermissions([...ctx.getPermissions(), permission]);
}

function removePrompt(
  ctx: MessageHandlerContext,
  kind: PermissionState['kind'],
  idField: string,
  idValue: string,
): void {
  ctx.setPermissions(
    ctx.getPermissions().filter((p) => {
      if (p.kind !== kind) return true;
      const data = p.data as Record<string, unknown>;
      return data[idField] !== idValue;
    }),
  );
}

function updateStreamInfo(
  state: ProgressState,
  streams: StreamTabInfo[],
  backendStates?: Record<string, StreamState>,
): ProgressState {
  const nextStates = new Map(state.streamStates);
  const knownStreams = new Set(streams.map((stream) => stream.name));

  for (const key of nextStates.keys()) {
    if (!knownStreams.has(key)) {
      nextStates.delete(key);
    }
  }

  for (const stream of streams) {
    const backendState = backendStates?.[stream.name];
    if (backendState) {
      nextStates.set(stream.name, { ...backendState, info: stream });
    } else {
      const existing =
        nextStates.get(stream.name) ?? createStreamState(stream.agentCategory);
      nextStates.set(stream.name, { ...existing, info: stream });
    }
  }

  return { ...state, streams, streamStates: nextStates };
}

// ============================================================
// Type-safe handler registry
// ============================================================

/**
 * Handler function type - receives typed message data (already validated).
 */
type TypedHandler<T extends ProgressViewOutboundMessage> = (
  data: T,
  ctx: MessageHandlerContext,
) => void;

/**
 * Handler registry mapping command to typed handler.
 * TypeScript ensures handlers receive the correct message type.
 */
type HandlerRegistry = {
  [K in ProgressViewOutboundMessage['command']]?: TypedHandler<
    Extract<ProgressViewOutboundMessage, { command: K }>
  >;
};

const handlers: HandlerRegistry = {
  // Stream management
  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS]: (data, ctx) => {
    const previousState = ctx.getState();
    const activeStream = data.activeStream ?? null;
    const updated = updateStreamInfo(
      previousState,
      data.streams,
      data.streamStates,
    );

    ctx.setState(() => ({
      ...updated,
      activeStreamId: activeStream || null,
      streamFilter: data.agentFilter,
    }));
  },

  [PROGRESS_VIEW_COMMANDS.DELETE_STREAM]: (data, ctx) => {
    const streamId = data.stream;
    const state = ctx.getState();

    const nextStates = new Map(state.streamStates);
    nextStates.delete(streamId);

    const nextStreams = state.streams.filter((s) => s.name !== streamId);
    const nextActiveStreamId =
      state.activeStreamId === streamId ? null : state.activeStreamId;

    if (state.activeStreamId === streamId) {
      pendingLogUpdates.clear();
    }

    ctx.setState(() => ({
      ...state,
      streams: nextStreams,
      streamStates: nextStates,
      activeStreamId: nextActiveStreamId,
    }));
  },

  [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: (_data, ctx) => {
    pendingLogUpdates.clear();
    ctx.setState((prev) => ({
      ...prev,
      streams: [],
      streamStates: new Map(),
      activeStreamId: null,
    }));
  },

  // Log updates
  [PROGRESS_VIEW_COMMANDS.UPDATE_LOGS]: (data, ctx) => {
    const { stream, messages, groups, action } = data;

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
      } = data;

      let processedMessages = isClear ? [] : messages;
      if (!isClear && isToolUseState(prev) && runInstructions) {
        processedMessages = prependInstructionForToolUse(
          [...messages],
          runInstructions,
          stream,
        );
      }

      const baseUpdate = {
        ...prev,
        logs: processedMessages,
        taskGroups: isClear ? [] : (groups ?? prev.taskGroups),
        contextState: contextState ?? prev.contextState,
      };

      if (isWorkflowState(prev)) {
        return {
          ...baseUpdate,
          activeRunId: activeRunId ?? prev.activeRunId,
          runInstructions: runInstructions
            ? { ...prev.runInstructions, ...runInstructions }
            : prev.runInstructions,
          runUsage: runUsage
            ? { ...prev.runUsage, ...runUsage }
            : prev.runUsage,
          runFiles: runFiles
            ? { ...prev.runFiles, ...runFiles }
            : prev.runFiles,
          runMissingOutputs: runMissingOutputs
            ? { ...prev.runMissingOutputs, ...runMissingOutputs }
            : prev.runMissingOutputs,
        };
      }

      return baseUpdate;
    });
  },

  [PROGRESS_VIEW_COMMANDS.APPEND_LOG]: (data, ctx) => {
    const logId = data.logMessage.id;
    const pendingUpdate = logId ? pendingLogUpdates.get(logId) : null;

    const mergedLogMessage = pendingUpdate
      ? { ...data.logMessage, ...pendingUpdate }
      : data.logMessage;

    if (logId && pendingUpdate) {
      pendingLogUpdates.delete(logId);
    }

    ctx.setStreamState(data.stream, (prev) => ({
      ...prev,
      logs: [...prev.logs, mergedLogMessage],
    }));
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_LOG]: (data, ctx) => {
    const logId = data.logMessage.id;
    const state = ctx.getState();
    const streamState = getStreamState(state, data.stream);
    const logExists = streamState.logs.some((entry) => entry.id === logId);

    if (!logExists) {
      if (logId) {
        const existingUpdate = pendingLogUpdates.get(logId) ?? {};
        pendingLogUpdates.set(logId, {
          ...existingUpdate,
          ...data.logMessage,
        });
      }
      return;
    }

    ctx.setStreamState(data.stream, (prev) => ({
      ...prev,
      logs: prev.logs.map((entry) =>
        entry.id === data.logMessage.id ? data.logMessage : entry,
      ),
    }));
  },

  // Status updates
  [PROGRESS_VIEW_COMMANDS.UPDATE_STATUS]: (data, ctx) => {
    const streamId = ctx.getState().activeStreamId;
    if (!streamId) return;

    ctx.setStreamState(streamId, (prev) => ({
      ...prev,
      status: data.status,
      ...(data.status === 'waiting' ? { shouldFocusFollowUp: true } : {}),
    }));
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS]: (data, ctx) => {
    const { stream, status, lastTimestamp } = data;
    const isActiveStream = stream === ctx.getState().activeStreamId;

    ctx.setStreamState(stream, (prev) => ({
      ...prev,
      status,
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
  },

  // File and output updates
  [PROGRESS_VIEW_COMMANDS.UPDATE_FILES]: (data, ctx) => {
    const { stream, ...update } = data;
    updateWorkflowState(ctx, stream, (prev) => ({
      ...prev,
      runFiles: updateNestedRounds(prev.runFiles, update),
    }));
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS]: (data, ctx) => {
    const { stream, ...update } = data;
    updateWorkflowState(ctx, stream, (prev) => ({
      ...prev,
      runMissingOutputs: updateNestedRounds(prev.runMissingOutputs, update),
    }));
  },

  // Run-specific updates
  [PROGRESS_VIEW_COMMANDS.UPDATE_INSTRUCTION]: (data, ctx) => {
    const { stream, instruction } = data;
    if (!stream) return;

    updateWorkflowState(ctx, stream, (prev) => {
      const runId = resolveActiveRunId(prev) ?? 'default';
      const { [runId]: _, ...rest } = prev.runInstructions;
      return {
        ...prev,
        runInstructions: instruction ? { ...rest, [runId]: instruction } : rest,
      };
    });
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE]: (data, ctx) => {
    const { stream, runId, usage } = data;
    updateWorkflowState(ctx, stream, (prev) => ({
      ...prev,
      runUsage: { ...prev.runUsage, [runId]: usage },
    }));
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_USAGE]: (data, ctx) => {
    const { stream, usage } = data;
    updateWorkflowState(ctx, stream, (prev) => ({
      ...prev,
      runUsage: usage,
    }));
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_CONTEXT_STATE]: (data, ctx) => {
    ctx.setStreamState(data.stream, (prev) => ({
      ...prev,
      contextState: data.contextState,
    }));
  },

  // Task group updates
  [PROGRESS_VIEW_COMMANDS.ADD_TASK_GROUP]: (data, ctx) => {
    ctx.setStreamState(data.stream, (prev) => ({
      ...prev,
      taskGroups: [...prev.taskGroups, data.group],
    }));
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_TASK_GROUP]: (data, ctx) => {
    const { streamId, id, status, endTime } = data.update;
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
  },

  // Tool-use specific
  [PROGRESS_VIEW_COMMANDS.UPDATE_TODOS]: (data, ctx) => {
    updateToolUseState(ctx, data.stream, (prev) => ({
      ...prev,
      todos: data.todos,
    }));
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS]: (data, ctx) => {
    updateToolUseState(ctx, data.stream, (prev) => ({
      ...prev,
      queuedFollowUps: data.messages,
    }));
  },

  // Approval requests
  [PROGRESS_VIEW_COMMANDS.SHOW_TOOL_EDIT_APPROVAL]: (data, ctx) => {
    addPermission(ctx, { kind: PERMISSION_KIND.TOOL_EDIT, data: data.request });
  },

  [PROGRESS_VIEW_COMMANDS.RESOLVE_TOOL_EDIT_APPROVAL]: (data, ctx) => {
    removePrompt(ctx, PERMISSION_KIND.TOOL_EDIT, 'requestId', data.requestId);
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_TOOL_EDIT_APPROVAL_STATE]: (data, ctx) => {
    updateToolUseState(ctx, data.stream, (prev) => ({
      ...prev,
      toolEditBypass: data.bypassActive,
    }));
  },

  [PROGRESS_VIEW_COMMANDS.SHOW_BASH_APPROVAL]: (data, ctx) => {
    addPermission(ctx, { kind: PERMISSION_KIND.BASH, data: data.request });
  },

  [PROGRESS_VIEW_COMMANDS.RESOLVE_BASH_APPROVAL]: (data, ctx) => {
    removePrompt(ctx, PERMISSION_KIND.BASH, 'requestId', data.requestId);
  },

  [PROGRESS_VIEW_COMMANDS.SHOW_RETRY_REQUEST]: (data, ctx) => {
    addPermission(ctx, { kind: PERMISSION_KIND.RETRY, data: data.request });
  },

  [PROGRESS_VIEW_COMMANDS.RESOLVE_RETRY_REQUEST]: (data, ctx) => {
    removePrompt(ctx, PERMISSION_KIND.RETRY, 'streamId', data.streamId);
  },

  [PROGRESS_VIEW_COMMANDS.SHOW_AGENT_PROPOSAL]: (data, ctx) => {
    addPermission(ctx, { kind: PERMISSION_KIND.PROPOSAL, data: data.proposal });
  },

  [PROGRESS_VIEW_COMMANDS.RESOLVE_AGENT_PROPOSAL]: (data, ctx) => {
    removePrompt(ctx, PERMISSION_KIND.PROPOSAL, 'proposalId', data.proposalId);
  },

  // Follow-up and recording
  [PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_POLISHED]: (data, ctx) => {
    const streamId = ctx.getState().activeStreamId;
    if (!streamId) return;

    updateToolUseState(ctx, streamId, (prev) => ({
      ...prev,
      followUpText: data.text,
      polishedText: data.text,
      shouldFocusFollowUp: true,
    }));
  },

  [PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_TRANSCRIBED]: (data, ctx) => {
    const streamId = ctx.getState().activeStreamId;
    if (!streamId) return;

    updateToolUseState(ctx, streamId, (prev) => ({
      ...prev,
      transcribedText: data.text,
      shouldFocusFollowUp: true,
    }));
  },

  [PROGRESS_VIEW_COMMANDS.RECORDING_STARTED]: (_data, ctx) => {
    const streamId = ctx.getState().activeStreamId;
    if (!streamId) return;

    updateToolUseState(ctx, streamId, (prev) => ({
      ...prev,
      recording: true,
    }));
  },

  [PROGRESS_VIEW_COMMANDS.RECORDING_STOPPED]: (_data, ctx) => {
    const streamId = ctx.getState().activeStreamId;
    if (!streamId) return;

    updateToolUseState(ctx, streamId, (prev) => ({
      ...prev,
      recording: false,
    }));
  },

  [PROGRESS_VIEW_COMMANDS.RECORDING_ERROR]: (_data, ctx) => {
    const streamId = ctx.getState().activeStreamId;
    if (!streamId) return;

    updateToolUseState(ctx, streamId, (prev) => ({
      ...prev,
      recording: false,
    }));
  },

  [PROGRESS_VIEW_COMMANDS.SET_FOLLOWUP_OPTIONS]: (data, ctx) => {
    const { command: _command, ...options } = data;

    ctx.setState((prev) => ({
      ...prev,
      followupOptions: options,
    }));
  },
};

// ============================================================
// Main dispatcher
// ============================================================

/**
 * Dispatch a message to its handler using schema-driven validation.
 *
 * Parses the raw message once with the discriminated union schema,
 * then routes to the appropriate typed handler.
 *
 * @param raw - Raw message from VS Code postMessage
 * @param ctx - Message handler context with state accessors
 * @returns true if message was handled, false otherwise
 */
export function dispatchMessage(
  raw: unknown,
  ctx: MessageHandlerContext,
): boolean {
  const result = ProgressViewOutboundMessageSchema.safeParse(raw);
  if (!result.success) {
    return false;
  }

  const message = result.data;
  const handler = handlers[message.command] as
    | TypedHandler<typeof message>
    | undefined;

  if (handler) {
    handler(message, ctx);
    return true;
  }

  return false;
}
