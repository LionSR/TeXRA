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
  sumUsageStats,
  type LogMessageData,
  type ProgressViewOutboundMessage,
  type StreamTabInfo,
} from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view
import { STREAM_STATUS } from './constants';
import {
  updateToolUseState,
  updateWorkflowState,
  updateNestedRounds,
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

/**
 * Proposal IDs that were resolved before their SHOW message arrived.
 * When RESOLVE arrives for a proposal not yet in the permission list, we stash the ID.
 * A subsequent SHOW for a stashed ID is dropped instead of creating a ghost permission.
 * Entries are cleaned up when the late SHOW arrives or on the next SHOW for a different proposal.
 */
const resolvedBeforeShown = new Set<string>();

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

/**
 * Upsert a proposal permission. If one with the same proposalId already exists
 * (e.g., a model-options update after the initial show), replace it in-place
 * to preserve ordering. Otherwise prepend as a new permission.
 */
function upsertProposalPermission(
  ctx: MessageHandlerContext,
  permission: PermissionState & { kind: typeof PERMISSION_KIND.PROPOSAL },
): void {
  const permissions = ctx.getPermissions();
  const idx = permissions.findIndex(
    (p) =>
      p.kind === PERMISSION_KIND.PROPOSAL &&
      p.data.proposalId === permission.data.proposalId,
  );
  if (idx >= 0) {
    const updated = [...permissions];
    updated[idx] = permission;
    ctx.setPermissions(updated);
  } else {
    ctx.setPermissions([permission, ...permissions]);
  }
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
  updateToolUseState(ctx, streamId, (prev) => ({
    ...prev,
    ui: { ...prev.ui, recording },
  }));
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
      // Preserve frontend-owned properties:
      // - 'ui': frontend UI state (follow-up text, polish state, etc.)
      // - 'logs': managed by APPEND_LOG/UPDATE_LOGS, not UPDATE_STREAMS
      // - 'taskGroups': managed by ADD_TASK_GROUP/UPDATE_TASK_GROUP
      // Backend's _streamStates never populates logs/taskGroups (always [])
      const preserveUI = existing && existing.kind === backendState.kind;
      nextStates.set(stream.name, {
        ...backendState,
        logs: existing?.logs ?? backendState.logs,
        taskGroups: existing?.taskGroups ?? backendState.taskGroups,
        ...(preserveUI && { ui: existing.ui }),
        info: stream,
      } as StreamState);
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
    const nextActiveStreamId =
      activeStream && validStreamIds.has(activeStream)
        ? activeStream
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

      const baseUpdate = {
        ...prev,
        logs: isClear ? [] : messages,
        taskGroups: isClear ? [] : (groups ?? prev.taskGroups),
        contextState: contextState ?? prev.contextState,
      };

      if (isWorkflowState(prev)) {
        if (isClear) {
          return {
            ...baseUpdate,
            activeRunId: null,
            ui: { ...prev.ui, selectedRunId: null },
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

      // Tool-use streams: compute sessionUsage from runUsage (sum all runs)
      if (isToolUseState(prev) && runUsage) {
        return {
          ...baseUpdate,
          sessionUsage: sumUsageStats(Object.values(runUsage)),
        };
      }

      return baseUpdate;
    });
  },

  // --- Log updates: use the fast path (updateStreamLogs) ---
  // These bypass setStreamState → willUpdate → updateContexts entirely.
  // The updater operates on logs[] directly — no StreamState spread needed.

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

    // Fast path: skips unknown streams (no state entry yet → gets full state via UPDATE_LOGS)
    ctx.updateStreamLogs(data.stream, (logs) => [...logs, mergedLogMessage]);
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_LOG]: (data, ctx) => {
    const logId = data.logMessage.id;

    ctx.updateStreamLogs(data.stream, (logs) => {
      const logIndex = logs.findIndex((entry) => entry.id === logId);

      if (logIndex < 0) {
        // Out-of-order: APPEND hasn't arrived yet, stash for later merge
        if (logId) {
          const key = getPendingLogKey(data.stream, logId);
          const existingUpdate = pendingLogUpdates.get(key) ?? {};
          pendingLogUpdates.set(key, {
            ...existingUpdate,
            ...data.logMessage,
          });
        }
        return logs; // Same reference → updateStreamLogs skips context update
      }

      const newLogs = [...logs];
      newLogs[logIndex] = data.logMessage;
      return newLogs;
    });
  },

  // Status updates
  [PROGRESS_VIEW_COMMANDS.UPDATE_STATUS]: (data, ctx) => {
    const streamId = ctx.getState().activeStreamId;
    if (!streamId) return;

    ctx.setStreamState(streamId, (prev) => {
      const shouldFocus = data.status === STREAM_STATUS.WAITING;
      if (isToolUseState(prev) && shouldFocus) {
        return {
          ...prev,
          status: data.status,
          ui: { ...prev.ui, shouldFocusFollowUp: true },
        };
      }
      return { ...prev, status: data.status };
    });
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS]: (data, ctx) => {
    const { stream, status, lastTimestamp } = data;
    const state = ctx.getState();
    const isActiveStream = stream === state.activeStreamId;
    const shouldFocus = isActiveStream && status === STREAM_STATUS.WAITING;

    // Single atomic update: stream state + tab metadata in one setState call,
    // avoiding two Map copies and two Lit re-render triggers.
    ctx.setState((prev) => {
      const streamInfo = prev.streams.find((s) => s.name === stream);
      const nextStates = new Map(prev.streamStates);

      if (streamInfo) {
        const current = getStreamState(prev, stream, streamInfo.agentCategory);
        const updatedState =
          isToolUseState(current) && shouldFocus
            ? {
                ...current,
                status,
                ui: { ...current.ui, shouldFocusFollowUp: true },
              }
            : { ...current, status };
        nextStates.set(stream, updatedState);
      }

      return {
        ...prev,
        streamStates: nextStates,
        streams: prev.streams.map((item) =>
          item.name === stream
            ? {
                ...item,
                status,
                lastTimestamp: lastTimestamp ?? item.lastTimestamp,
              }
            : item,
        ),
      };
    });
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
    const { stream, instruction, runId } = data;
    if (!stream || !runId) return;

    updateWorkflowState(ctx, stream, (prev) => {
      const { [runId]: _, ...rest } = prev.runInstructions;
      return {
        ...prev,
        runInstructions: instruction ? { ...rest, [runId]: instruction } : rest,
      };
    });
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE]: (data, ctx) => {
    const { stream, runId, usage } = data;
    // Use StreamState.kind as single source of truth for stream type
    ctx.setStreamState(stream, (prev) => {
      if (isToolUseState(prev)) {
        return { ...prev, sessionUsage: usage };
      }
      if (isWorkflowState(prev)) {
        return { ...prev, runUsage: { ...prev.runUsage, [runId]: usage } };
      }
      return prev;
    });
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
    // Drop if this proposal was already resolved (out-of-order messages)
    if (resolvedBeforeShown.delete(data.proposal.proposalId)) return;
    upsertProposalPermission(ctx, {
      kind: PERMISSION_KIND.PROPOSAL,
      data: data.proposal,
      modelOptions: data.modelOptionsData,
    });
  },

  [PROGRESS_VIEW_COMMANDS.RESOLVE_AGENT_PROPOSAL]: (data, ctx) => {
    const before = ctx.getPermissions().length;
    removePrompt(ctx, PERMISSION_KIND.PROPOSAL, 'proposalId', data.proposalId);
    // If nothing was removed, RESOLVE arrived before SHOW — stash the ID
    if (ctx.getPermissions().length === before) {
      resolvedBeforeShown.add(data.proposalId);
    }
  },

  // Follow-up and recording
  [PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_POLISHED]: (data, ctx) => {
    const streamId = data.stream;
    // Guard: ignore late-arriving messages for deleted streams
    if (!ctx.getState().streamStates.has(streamId)) return;

    updateToolUseState(ctx, streamId, (prev) => ({
      ...prev,
      ui: {
        ...prev.ui,
        followUpText: data.text,
        polishedText: data.text,
        polishRevision: (prev.ui.polishRevision ?? 0) + 1,
        shouldFocusFollowUp: true,
      },
    }));
  },

  [PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_POLISH_ERROR]: (data, ctx) => {
    const streamId = data.stream;
    // Guard: ignore late-arriving messages for deleted streams
    if (!ctx.getState().streamStates.has(streamId)) return;

    updateToolUseState(ctx, streamId, (prev) => ({
      ...prev,
      ui: {
        ...prev.ui,
        polishedText: prev.ui.followUpText ?? '',
        polishRevision: (prev.ui.polishRevision ?? 0) + 1,
        shouldFocusFollowUp: true,
      },
    }));
  },

  [PROGRESS_VIEW_COMMANDS.FOLLOW_UP_TEXT_TRANSCRIBED]: (data, ctx) => {
    const streamId = ctx.getState().activeStreamId;
    if (!streamId) return;

    updateToolUseState(ctx, streamId, (prev) => ({
      ...prev,
      ui: {
        ...prev.ui,
        transcribedText: data.text,
        shouldFocusFollowUp: true,
      },
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
