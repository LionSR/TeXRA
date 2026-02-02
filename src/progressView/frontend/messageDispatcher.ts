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
  TOOL_USE_FRONTEND_ONLY_KEYS,
  type LogMessageData,
  type ProgressViewOutboundMessage,
  type StreamTabInfo,
  type ToolUseStreamState,
} from '@shared/schemas';
import { getEffectiveRunId } from '@shared/streams/runSelection';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view
import { STREAM_STATUS } from './constants';
import {
  updateToolUseState,
  updateWorkflowState,
  updateNestedRounds,
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

function getPendingLogKey(streamId: string, logId: string): string {
  return `${streamId}:${logId}`;
}

function clearPendingLogUpdatesForStream(streamId: string): void {
  const prefix = `${streamId}:`;
  for (const key of pendingLogUpdates.keys()) {
    if (key.startsWith(prefix)) {
      pendingLogUpdates.delete(key);
    }
  }
}

function addPermission(
  ctx: MessageHandlerContext,
  permission: PermissionState,
): void {
  // Prepend newest permissions so keyboard shortcuts target the latest request.
  ctx.setPermissions([permission, ...ctx.getPermissions()]);
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

function setActiveStreamRecording(
  ctx: MessageHandlerContext,
  recording: boolean,
): void {
  const streamId = ctx.getState().activeStreamId;
  if (!streamId) return;
  updateToolUseState(ctx, streamId, (prev) => ({ ...prev, recording }));
}

/**
 * Extract frontend-only fields from an existing ToolUseStreamState.
 * Uses schema-defined TOOL_USE_FRONTEND_ONLY_KEYS for compile-time safety.
 * Returns empty object if the state is not a ToolUseStreamState.
 */
function extractFrontendOnlyFields(
  existing: StreamState | undefined,
): Partial<ToolUseStreamState> {
  if (!existing || !isToolUseState(existing)) return {};
  // Pick only the frontend-only fields from the existing state
  const {
    followUpText,
    polishedText,
    polishRevision,
    transcribedText,
    recording,
    shouldFocusFollowUp,
  } = existing;
  return {
    followUpText,
    polishedText,
    polishRevision,
    transcribedText,
    recording,
    shouldFocusFollowUp,
  };
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
      clearPendingLogUpdatesForStream(key);
    }
  }

  for (const stream of streams) {
    const backendState = backendStates?.[stream.name];
    if (backendState) {
      const existing = nextStates.get(stream.name);
      // Only preserve frontend-only fields for ToolUse streams
      if (isToolUseState(backendState)) {
        const frontendOnlyFields = extractFrontendOnlyFields(existing);
        nextStates.set(stream.name, {
          ...backendState,
          ...frontendOnlyFields,
          info: stream,
        });
      } else {
        nextStates.set(stream.name, { ...backendState, info: stream });
      }
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
    const activeStream = data.activeStream || null;
    const updated = updateStreamInfo(
      previousState,
      data.streams,
      data.streamStates,
    );
    const validStreamIds = new Set(data.streams.map((stream) => stream.name));
    const fallbackStreamId = data.streams.at(0)?.name ?? null;
    const nextActiveStreamId = activeStream
      ? validStreamIds.has(activeStream)
        ? activeStream
        : fallbackStreamId
      : fallbackStreamId;
    const nextFollowupOptions = new Map(
      [...previousState.followupOptionsByStream].filter(([streamId]) =>
        validStreamIds.has(streamId),
      ),
    );

    ctx.setState(() => ({
      ...updated,
      activeStreamId: nextActiveStreamId,
      streamFilter: data.agentFilter,
      followupOptionsByStream: nextFollowupOptions,
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

    // Always clear pending log updates for deleted stream, not just active stream
    clearPendingLogUpdatesForStream(streamId);

    ctx.setState(() => ({
      ...state,
      streams: nextStreams,
      streamStates: nextStates,
      activeStreamId: nextActiveStreamId,
      followupOptionsByStream: new Map(
        [...state.followupOptionsByStream].filter(
          ([streamKey]) => streamKey !== streamId,
        ),
      ),
    }));
  },

  [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: (_data, ctx) => {
    pendingLogUpdates.clear();
    ctx.setState((prev) => ({
      ...prev,
      streams: [],
      streamStates: new Map(),
      activeStreamId: null,
      followupOptionsByStream: new Map(),
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
      if (isClear) {
        clearPendingLogUpdatesForStream(stream);
      }
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
        if (isClear) {
          return {
            ...baseUpdate,
            activeRunId: null,
            selectedRunId: null,
            runInstructions: {},
            runUsage: {},
            runFiles: {},
            runMissingOutputs: {},
          };
        }
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
    const pendingUpdate =
      logId && data.stream
        ? pendingLogUpdates.get(getPendingLogKey(data.stream, logId))
        : null;

    const mergedLogMessage = pendingUpdate
      ? { ...data.logMessage, ...pendingUpdate }
      : data.logMessage;

    if (logId && pendingUpdate) {
      pendingLogUpdates.delete(getPendingLogKey(data.stream, logId));
    }

    ctx.setStreamState(data.stream, (prev) => ({
      ...prev,
      logs: [...prev.logs, mergedLogMessage],
    }));
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_LOG]: (data, ctx) => {
    const logId = data.logMessage.id;
    const state = ctx.getState();
    const streamInfo = state.streams.find(
      (stream) => stream.name === data.stream,
    );
    const streamState = getStreamState(
      state,
      data.stream,
      streamInfo?.agentCategory,
    );
    const logExists = streamState.logs.some((entry) => entry.id === logId);

    if (!logExists) {
      if (logId) {
        const key = getPendingLogKey(data.stream, logId);
        const existingUpdate = pendingLogUpdates.get(key) ?? {};
        pendingLogUpdates.set(key, {
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
      ...(data.status === STREAM_STATUS.WAITING && {
        shouldFocusFollowUp: true,
      }),
    }));
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS]: (data, ctx) => {
    const { stream, status, lastTimestamp } = data;
    const state = ctx.getState();
    const isActiveStream = stream === state.activeStreamId;

    ctx.setStreamState(stream, (prev) => ({
      ...prev,
      status,
      ...(isActiveStream &&
        status === STREAM_STATUS.WAITING && { shouldFocusFollowUp: true }),
    }));

    ctx.setState(() => ({
      ...state,
      streams: state.streams.map((item) =>
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
    const { stream, instruction, runId: providedRunId } = data;
    if (!stream) return;

    updateWorkflowState(ctx, stream, (prev) => {
      const runId =
        providedRunId ?? getEffectiveRunId(prev, { mode: 'fallback' });
      if (!runId) {
        console.warn(
          '[ProgressView] UPDATE_INSTRUCTION missing runId; skipping update.',
        );
        return prev;
      }
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
    ctx.setStreamState(streamId, (prev) => {
      const existingGroup = prev.taskGroups.find((group) => group.id === id);
      if (!existingGroup) {
        return prev;
      }

      return {
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
      };
    });
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
    const streamId = data.stream;
    // Guard: ignore late-arriving messages for deleted streams
    if (!ctx.getState().streamStates.has(streamId)) return;

    updateToolUseState(ctx, streamId, (prev) => ({
      ...prev,
      followUpText: data.text,
      polishedText: data.text,
      polishRevision: (prev.polishRevision ?? 0) + 1,
      shouldFocusFollowUp: true,
    }));
  },

  [PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_POLISH_ERROR]: (data, ctx) => {
    const streamId = data.stream;
    // Guard: ignore late-arriving messages for deleted streams
    if (!ctx.getState().streamStates.has(streamId)) return;

    updateToolUseState(ctx, streamId, (prev) => ({
      ...prev,
      polishedText: prev.followUpText ?? '',
      polishRevision: (prev.polishRevision ?? 0) + 1,
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

  [PROGRESS_VIEW_COMMANDS.RECORDING_STARTED]: (_data, ctx) =>
    setActiveStreamRecording(ctx, true),

  [PROGRESS_VIEW_COMMANDS.RECORDING_STOPPED]: (_data, ctx) =>
    setActiveStreamRecording(ctx, false),

  [PROGRESS_VIEW_COMMANDS.RECORDING_ERROR]: (_data, ctx) =>
    setActiveStreamRecording(ctx, false),

  [PROGRESS_VIEW_COMMANDS.SET_FOLLOWUP_OPTIONS]: (data, ctx) => {
    const { command: _command, stream, ...options } = data;
    if (!stream) {
      console.warn('SET_FOLLOWUP_OPTIONS missing stream ID.', { data });
      return;
    }
    // Guard: ignore late-arriving messages for deleted streams
    if (!ctx.getState().streamStates.has(stream)) return;

    ctx.setState((prev) => ({
      ...prev,
      followupOptionsByStream: new Map(prev.followupOptionsByStream).set(
        stream,
        options,
      ),
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
