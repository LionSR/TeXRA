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

// Local imports - shared schemas
import {
  createStreamState,
  ProgressViewOutboundMessageSchema,
  sumUsageStats,
  type LogMessageData,
  type ProgressViewOutboundMessage,
  type StreamMetadata,
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
  createStreamLogs,
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

/** Proposal IDs resolved before a show message arrives (out-of-order guard). */
export const resolvedProposalIds = new Set<string>();

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

export function removePrompt(
  ctx: MessageHandlerContext,
  kind: PermissionState['kind'],
  idField: string,
  idValue: string,
): boolean {
  const current = ctx.getPermissions();
  const next = current.filter((p) => {
    if (p.kind !== kind) return true;
    const data = p.data as Record<string, unknown>;
    return data[idField] !== idValue;
  });
  ctx.setPermissions(next);
  return next.length !== current.length;
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

function mergeBackendOwnedState(
  existing: StreamState,
  metadata: StreamMetadata,
): StreamState {
  if (existing.kind !== metadata.kind) {
    // Kind changed — create fresh state with new-kind defaults, overlay metadata,
    // and preserve frontend-owned taskGroups.
    return createStreamState(metadata.kind, {
      ...metadata,
      taskGroups: existing.taskGroups,
    });
  }
  return {
    ...existing,
    status: metadata.status,
    lastTimestamp: metadata.lastTimestamp,
    conversationProgress: metadata.conversationProgress,
    activeSubagents: metadata.activeSubagents,
    finishedSubagentCount: metadata.finishedSubagentCount,
    activeProcesses: metadata.activeProcesses,
    finishedProcessCount: metadata.finishedProcessCount,
  };
}

function updateStreamInfo(
  state: ProgressState,
  streams: StreamTabInfo[],
  backendMetadata?: Record<string, StreamMetadata>,
): ProgressState {
  const nextStates = new Map(state.streamStates);
  const nextLogs = new Map(state.streamLogs);
  const knownStreams = new Set(streams.map((stream) => stream.name));

  for (const key of nextStates.keys()) {
    if (!knownStreams.has(key)) {
      nextStates.delete(key);
      nextLogs.delete(key);
      clearPendingLogUpdatesForStream(key);
    }
  }

  for (const stream of streams) {
    const metadata = backendMetadata?.[stream.name];
    if (metadata) {
      const existing = nextStates.get(stream.name);
      nextStates.set(
        stream.name,
        existing
          ? mergeBackendOwnedState(existing, metadata)
          : createStreamState(stream.agentCategory, metadata),
      );
    } else {
      const existing =
        nextStates.get(stream.name) ?? createStreamState(stream.agentCategory);
      nextStates.set(stream.name, existing);
    }
  }

  return { ...state, streams, streamStates: nextStates, streamLogs: nextLogs };
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

  [PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM]: (data, ctx) => {
    ctx.setState((prev) => {
      const validStreamIds = new Set(prev.streams.map((stream) => stream.name));
      const fallbackStreamId = prev.streams.at(0)?.name ?? null;
      const nextActiveStreamId =
        data.activeStream && validStreamIds.has(data.activeStream)
          ? data.activeStream
          : fallbackStreamId;
      if (nextActiveStreamId === prev.activeStreamId) {
        return prev;
      }
      return { ...prev, activeStreamId: nextActiveStreamId };
    });
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_CONVERSATION_PROGRESS]: (data, ctx) => {
    ctx.setStreamState(data.stream, (prev) => ({
      ...prev,
      conversationProgress: data.progress,
    }));
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES]: (data, ctx) => {
    ctx.setStreamState(data.stream, (prev) => ({
      ...prev,
      activeSubagents: data.activeSubagents,
      finishedSubagentCount: data.finishedSubagentCount,
      activeProcesses: data.activeProcesses,
      finishedProcessCount: data.finishedProcessCount,
    }));
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_PARENT_STREAM]: (data, ctx) => {
    ctx.setState((prev) => {
      const nextParentStreamId = data.parentStreamId ?? undefined;
      const target = prev.streams.find((stream) => stream.name === data.stream);
      if (!target || target.parentStreamId === nextParentStreamId) return prev;
      const nextStreams = prev.streams.map((stream) =>
        stream.name === data.stream
          ? { ...stream, parentStreamId: nextParentStreamId }
          : stream,
      );
      return { ...prev, streams: nextStreams };
    });
  },

  [PROGRESS_VIEW_COMMANDS.DELETE_STREAM]: (data, ctx) => {
    const streamId = data.stream;
    const state = ctx.getState();

    const nextStates = new Map(state.streamStates);
    nextStates.delete(streamId);

    const nextLogs = new Map(state.streamLogs);
    nextLogs.delete(streamId);

    const nextStreams = state.streams.filter((s) => s.name !== streamId);
    const nextActiveStreamId =
      state.activeStreamId === streamId ? null : state.activeStreamId;

    // Always clear pending log updates for deleted stream, not just active stream
    clearPendingLogUpdatesForStream(streamId);

    ctx.setState(() => ({
      ...state,
      streams: nextStreams,
      streamStates: nextStates,
      streamLogs: nextLogs,
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
      streamLogs: new Map(),
      activeStreamId: null,
      followupOptionsByStream: new Map(),
    }));
  },

  // Log updates
  [PROGRESS_VIEW_COMMANDS.UPDATE_LOGS]: (data, ctx) => {
    const { stream, messages, groups, action } = data;

    if (!stream && action === 'clear') {
      pendingLogUpdates.clear();
      ctx.setState((prev) => ({
        ...prev,
        streamStates: new Map(),
        streamLogs: new Map(),
      }));
      return;
    }

    if (!stream) return;

    const isClear = action === 'clear';
    if (isClear) {
      clearPendingLogUpdatesForStream(stream);
    }

    // Update meta first — setStreamState creates the streamStates entry if needed,
    // which setStreamLogs requires (it guards against unknown streams).
    ctx.setStreamState(stream, (prev): StreamState => {
      const {
        activeRunId,
        runInstructions,
        runUsage,
        runFiles,
        runMissingOutputs,
        contextState,
      } = data;

      const base = {
        taskGroups: isClear ? [] : (groups ?? prev.taskGroups),
        contextState: contextState ?? prev.contextState,
      };

      if (isWorkflowState(prev)) {
        if (isClear) {
          return {
            ...prev,
            ...base,
            activeRunId: null,
            ui: { ...prev.ui, selectedRunId: null },
            runInstructions: {},
            runUsage: {},
            runFiles: {},
            runMissingOutputs: {},
          };
        }
        return {
          ...prev,
          ...base,
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
      // Ignore empty payloads so we don't overwrite existing totals with zeros.
      if (
        isToolUseState(prev) &&
        runUsage &&
        Object.keys(runUsage).length > 0
      ) {
        return {
          ...prev,
          ...base,
          sessionUsage: sumUsageStats(Object.values(runUsage)),
        };
      }

      return { ...prev, ...base };
    });

    if (isClear) {
      ctx.setState((prev) => {
        const nextLogs = new Map(prev.streamLogs);
        nextLogs.delete(stream);
        return { ...prev, streamLogs: nextLogs };
      });
      return;
    }

    // Update logs in the separate streamLogs Map (after setStreamState so the entry exists)
    ctx.setStreamLogs(stream, () => createStreamLogs(messages));
  },

  // --- Log updates ---
  // These use setStreamLogs so only the streamLogs Map gets a new entry.
  // The streamStates Map stays unchanged, so meta context consumers
  // (content components) skip re-rendering on log-only updates.

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

    ctx.setStreamLogs(data.stream, (prev) => {
      // O(1) duplicate check via logIndex (race between UPDATE_LOGS and
      // APPEND_LOG can cause the same entry to arrive twice).
      if (logId && prev.logIndex.has(logId)) {
        return prev;
      }
      const newLogs = [...prev.logs, mergedLogMessage];
      const newIndex = new Map(prev.logIndex as Map<string, number>);
      newIndex.set(logId, newLogs.length - 1);
      return { logs: newLogs, logIndex: newIndex };
    });
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_LOG]: (data, ctx) => {
    const logId = data.logMessage.id;

    ctx.setStreamLogs(data.stream, (prev) => {
      const idx = prev.logIndex.get(logId);

      if (idx === undefined) {
        // Out-of-order: APPEND hasn't arrived yet, stash for later merge
        if (logId) {
          const key = getPendingLogKey(data.stream, logId);
          const existingUpdate = pendingLogUpdates.get(key) ?? {};
          pendingLogUpdates.set(key, {
            ...existingUpdate,
            ...data.logMessage,
          });
        }
        return prev; // Same reference → setStreamLogs skips update
      }

      const newLogs = [...prev.logs];
      newLogs[idx] = data.logMessage;
      // Reuse logIndex — position unchanged, only the object at that index
      return { logs: newLogs, logIndex: prev.logIndex };
    });
  },

  // Status updates
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
                lastTimestamp: lastTimestamp ?? current.lastTimestamp,
                ui: { ...current.ui, shouldFocusFollowUp: true },
              }
            : {
                ...current,
                status,
                lastTimestamp: lastTimestamp ?? current.lastTimestamp,
              };
        nextStates.set(stream, updatedState);
      }

      return {
        ...prev,
        streamStates: nextStates,
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
  [PROGRESS_VIEW_COMMANDS.UPDATE_BYPASS]: (data, ctx) => {
    updateToolUseState(ctx, data.stream, (prev) =>
      data.type === 'toolEdit'
        ? { ...prev, toolEditBypass: data.bypassActive }
        : { ...prev, superYoloBypass: data.bypassActive },
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_PERMISSION]: (data, ctx) => {
    if (data.action === 'show') {
      const { permission } = data;
      if (permission.kind === PERMISSION_KIND.PROPOSAL) {
        // Drop if this proposal was already resolved (out-of-order messages)
        if (resolvedProposalIds.delete(permission.data.proposalId)) return;
        upsertProposalPermission(ctx, {
          kind: PERMISSION_KIND.PROPOSAL,
          data: permission.data,
          modelOptions: permission.modelOptionsData,
        });
        return;
      }

      if (permission.kind === PERMISSION_KIND.TOOL_EDIT) {
        addPermission(ctx, {
          kind: PERMISSION_KIND.TOOL_EDIT,
          data: permission.data,
        });
        return;
      }

      if (permission.kind === PERMISSION_KIND.BASH) {
        addPermission(ctx, {
          kind: PERMISSION_KIND.BASH,
          data: permission.data,
        });
        return;
      }

      addPermission(ctx, {
        kind: PERMISSION_KIND.RETRY,
        data: permission.data,
      });
      return;
    }

    const { kind, id } = data;
    if (kind === PERMISSION_KIND.TOOL_EDIT) {
      removePrompt(ctx, PERMISSION_KIND.TOOL_EDIT, 'requestId', id);
      return;
    }
    if (kind === PERMISSION_KIND.BASH) {
      removePrompt(ctx, PERMISSION_KIND.BASH, 'requestId', id);
      return;
    }
    if (kind === PERMISSION_KIND.RETRY) {
      removePrompt(ctx, PERMISSION_KIND.RETRY, 'streamId', id);
      return;
    }

    const removed = removePrompt(
      ctx,
      PERMISSION_KIND.PROPOSAL,
      'proposalId',
      id,
    );
    if (!removed) {
      resolvedProposalIds.add(id);
    }
  },

  // Batched content sync (tab switch: logs + todos + follow-ups + instruction in one message)
  [PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT]: (data, ctx) => {
    // Delegate to individual handlers — Lit batches synchronous property
    // changes into a single microtask update, so multiple setState calls
    // still result in one render cycle. The main win is reducing 4 postMessage
    // round-trips to 1.

    // 1. Logs (same logic as UPDATE_LOGS handler)
    handlers[PROGRESS_VIEW_COMMANDS.UPDATE_LOGS]?.(
      {
        command: PROGRESS_VIEW_COMMANDS.UPDATE_LOGS,
        stream: data.stream,
        messages: data.messages,
        groups: data.groups,
        action: data.action,
        runInstructions: data.runInstructions,
        activeRunId: data.activeRunId,
        runUsage: data.runUsage,
        runFiles: data.runFiles,
        runMissingOutputs: data.runMissingOutputs,
        contextState: data.contextState,
      },
      ctx,
    );

    if (!data.stream || data.action === 'clear') return;

    // 2. Todos
    if (data.todos) {
      updateToolUseState(ctx, data.stream, (prev) => ({
        ...prev,
        todos: data.todos!,
      }));
    }

    // 3. Queued follow-ups
    if (data.queuedFollowUps) {
      updateToolUseState(ctx, data.stream, (prev) => ({
        ...prev,
        queuedFollowUps: data.queuedFollowUps!,
      }));
    }

    // 4. Instruction
    if (data.instruction !== undefined && data.runId) {
      updateWorkflowState(ctx, data.stream, (prev) => {
        const runId = data.runId as string;
        const { [runId]: _, ...rest } = prev.runInstructions;
        return {
          ...prev,
          runInstructions: data.instruction
            ? { ...rest, [runId]: data.instruction }
            : rest,
        };
      });
    }
  },

  // Follow-up and recording
  [PROGRESS_VIEW_COMMANDS.UPDATE_FOLLOW_UP_TEXT]: (data, ctx) => {
    const streamId =
      data.stream ??
      (data.kind === 'transcribed' ? ctx.getState().activeStreamId : null);
    if (!streamId) return;
    if (!ctx.getState().streamStates.has(streamId)) return;

    updateToolUseState(ctx, streamId, (prev) => {
      if (data.kind === 'polished' && data.text) {
        return {
          ...prev,
          ui: {
            ...prev.ui,
            followUpText: data.text,
            polishedText: data.text,
            polishRevision: prev.ui.polishRevision + 1,
            shouldFocusFollowUp: true,
          },
        };
      }

      if (data.kind === 'polishError') {
        return {
          ...prev,
          ui: {
            ...prev.ui,
            polishedText: prev.ui.followUpText,
            polishRevision: prev.ui.polishRevision + 1,
            shouldFocusFollowUp: true,
          },
        };
      }

      if (data.kind === 'transcribed' && data.text) {
        return {
          ...prev,
          ui: {
            ...prev.ui,
            transcribedText: data.text,
            shouldFocusFollowUp: true,
          },
        };
      }

      return prev;
    });
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_RECORDING]: (data, ctx) =>
    setActiveStreamRecording(ctx, data.status === 'started'),

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
