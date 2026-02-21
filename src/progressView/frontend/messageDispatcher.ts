/**
 * Schema-driven message dispatcher for ProgressView.
 *
 * Routes typed backend messages to handlers via command lookup.
 * Backend messages are trusted (TypeScript-enforced, structured clone IPC).
 *
 * @example
 * // In ProgressApp.handleMessage:
 * dispatchMessage(raw, ctx);
 */

import { create } from 'mutative';

// Local imports - shared schemas
import {
  createStreamState,
  sumUsageStats,
  type LogMessageData,
  type LogsPayload,
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
  buildStreamById,
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
  updateToolUseState(ctx, streamId, (prev) =>
    create(prev, (draft) => {
      draft.ui.recording = recording;
    }),
  );
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
  return create(existing, (draft) => {
    draft.status = metadata.status;
    draft.lastTimestamp = metadata.lastTimestamp;
    draft.conversationProgress = metadata.conversationProgress;
    draft.activeSubagents = metadata.activeSubagents;
    draft.finishedSubagentCount = metadata.finishedSubagentCount;
    draft.activeProcesses = metadata.activeProcesses;
    draft.finishedProcessCount = metadata.finishedProcessCount;
  });
}

function updateStreamInfo(
  state: ProgressState,
  streams: StreamTabInfo[],
  backendMetadata?: Record<string, StreamMetadata>,
): ProgressState {
  // Pre-compute merged states outside the draft (mergeBackendOwnedState uses
  // create() internally, which cannot operate on draft proxies).
  const mergedStates = new Map<string, StreamState>();
  for (const stream of streams) {
    const existing = state.streamStates.get(stream.name);
    const metadata = backendMetadata?.[stream.name];
    if (metadata) {
      mergedStates.set(
        stream.name,
        existing
          ? mergeBackendOwnedState(existing, metadata)
          : createStreamState(stream.agentCategory, metadata),
      );
    } else if (!existing) {
      mergedStates.set(stream.name, createStreamState(stream.agentCategory));
    }
  }

  // Build streamById once — reuse for cleanup check instead of a separate Set.
  const newStreamById = buildStreamById(streams);

  return create(state, (draft) => {
    for (const key of draft.streamStates.keys()) {
      if (!newStreamById.has(key)) {
        draft.streamStates.delete(key);
        draft.streamLogs.delete(key);
        clearPendingLogUpdatesForStream(key);
      }
    }

    for (const [name, merged] of mergedStates) {
      draft.streamStates.set(name, merged);
    }

    draft.streams = streams;
    draft.streamById = newStreamById;
  });
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

/**
 * Shared log-update logic used by both UPDATE_LOGS and SYNC_STREAM_CONTENT.
 * Extracted to avoid the handler-calls-handler pattern with synthetic messages.
 */
function applyLogUpdate(data: LogsPayload, ctx: MessageHandlerContext): void {
  const { stream, messages, groups, action } = data;

  if (!stream && action === 'clear') {
    pendingLogUpdates.clear();
    ctx.setState((prev) =>
      create(prev, (draft) => {
        draft.streamStates = new Map();
        draft.streamLogs = new Map();
      }),
    );
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

    if (isWorkflowState(prev)) {
      if (isClear) {
        return create(prev, (draft) => {
          draft.taskGroups = [];
          draft.contextState = contextState ?? prev.contextState;
          draft.activeRunId = null;
          draft.ui.selectedRunId = null;
          draft.runInstructions = {};
          draft.runUsage = {};
          draft.runFiles = {};
          draft.runMissingOutputs = {};
        });
      }
      return create(prev, (draft) => {
        draft.taskGroups = groups ?? prev.taskGroups;
        draft.contextState = contextState ?? prev.contextState;
        draft.activeRunId = activeRunId ?? prev.activeRunId;
        if (runInstructions)
          Object.assign(draft.runInstructions, runInstructions);
        if (runUsage) Object.assign(draft.runUsage, runUsage);
        if (runFiles) Object.assign(draft.runFiles, runFiles);
        if (runMissingOutputs)
          Object.assign(draft.runMissingOutputs, runMissingOutputs);
      });
    }

    // Tool-use streams: store per-run usage and derive sessionUsage as their sum.
    // Ignore empty payloads so we don't overwrite existing totals with zeros.
    if (isToolUseState(prev) && runUsage && Object.keys(runUsage).length > 0) {
      return create(prev, (draft) => {
        draft.taskGroups = isClear ? [] : (groups ?? prev.taskGroups);
        draft.contextState = contextState ?? prev.contextState;
        Object.assign(draft.runUsage, runUsage);
        draft.sessionUsage = sumUsageStats(Object.values(draft.runUsage));
      });
    }

    return create(prev, (draft) => {
      draft.taskGroups = isClear ? [] : (groups ?? prev.taskGroups);
      draft.contextState = contextState ?? prev.contextState;
    });
  });

  if (isClear) {
    ctx.setState((prev) =>
      create(prev, (draft) => {
        draft.streamLogs.delete(stream);
      }),
    );
    return;
  }

  // Update logs in the separate streamLogs Map (after setStreamState so the entry exists)
  ctx.setStreamLogs(stream, () => createStreamLogs(messages));
}

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
    // Reuse streamById built by updateStreamInfo instead of building a Set
    const fallbackStreamId = data.streams.at(0)?.name ?? null;
    const nextActiveStreamId =
      activeStream && updated.streamById.has(activeStream)
        ? activeStream
        : fallbackStreamId;

    ctx.setState(() =>
      create(updated, (draft) => {
        draft.activeStreamId = nextActiveStreamId;
        draft.streamFilter = data.agentFilter;
        for (const key of draft.followupOptionsByStream.keys()) {
          if (!updated.streamById.has(key)) {
            draft.followupOptionsByStream.delete(key);
          }
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM]: (data, ctx) => {
    ctx.setState((prev) => {
      const fallbackStreamId = prev.streams.at(0)?.name ?? null;
      const nextActiveStreamId =
        data.activeStream && prev.streamById.has(data.activeStream)
          ? data.activeStream
          : fallbackStreamId;
      if (nextActiveStreamId === prev.activeStreamId) {
        return prev;
      }
      return create(prev, (draft) => {
        draft.activeStreamId = nextActiveStreamId;
      });
    });
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_CONVERSATION_PROGRESS]: (data, ctx) => {
    ctx.setStreamState(data.stream, (prev) =>
      create(prev, (draft) => {
        draft.conversationProgress = data.progress;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES]: (data, ctx) => {
    ctx.setStreamState(data.stream, (prev) =>
      create(prev, (draft) => {
        draft.activeSubagents = data.activeSubagents;
        draft.finishedSubagentCount = data.finishedSubagentCount;
        draft.activeProcesses = data.activeProcesses;
        draft.finishedProcessCount = data.finishedProcessCount;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_PARENT_STREAM]: (data, ctx) => {
    ctx.setState((prev) => {
      const nextParentStreamId = data.parentStreamId ?? undefined;
      const target = prev.streamById.get(data.stream);
      if (!target || target.parentStreamId === nextParentStreamId) return prev;
      const idx = prev.streams.indexOf(target);
      const updated = { ...target, parentStreamId: nextParentStreamId };
      return create(prev, (draft) => {
        draft.streams[idx] = updated;
        draft.streamById.set(data.stream, updated);
      });
    });
  },

  [PROGRESS_VIEW_COMMANDS.DELETE_STREAM]: (data, ctx) => {
    const streamId = data.stream;

    // Always clear pending log updates for deleted stream, not just active stream
    clearPendingLogUpdatesForStream(streamId);

    ctx.setState((prev) =>
      create(prev, (draft) => {
        draft.streamStates.delete(streamId);
        draft.streamLogs.delete(streamId);
        draft.streams = draft.streams.filter((s) => s.name !== streamId);
        draft.streamById.delete(streamId);
        if (draft.activeStreamId === streamId) {
          draft.activeStreamId = null;
        }
        draft.followupOptionsByStream.delete(streamId);
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: (_data, ctx) => {
    pendingLogUpdates.clear();
    ctx.setState((prev) =>
      create(prev, (draft) => {
        draft.streams = [];
        draft.streamById = new Map();
        draft.streamStates = new Map();
        draft.streamLogs = new Map();
        draft.activeStreamId = null;
        draft.followupOptionsByStream = new Map();
      }),
    );
  },

  // Log updates
  [PROGRESS_VIEW_COMMANDS.UPDATE_LOGS]: (data, ctx) =>
    applyLogUpdate(data, ctx),

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
      // Mutate logIndex in place — no downstream code checks Map reference
      // identity; it's only used for O(1) lookups within handlers.
      prev.logIndex.set(logId, newLogs.length - 1);
      return { logs: newLogs, logIndex: prev.logIndex };
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
      const streamInfo = prev.streamById.get(stream);
      if (!streamInfo) return prev;

      const current = getStreamState(prev, stream, streamInfo.agentCategory);
      const resolvedTimestamp = lastTimestamp ?? current.lastTimestamp;
      const updatedState = create(current, (draft) => {
        draft.status = status;
        draft.lastTimestamp = resolvedTimestamp;
        if (isToolUseState(current) && shouldFocus) {
          (draft as typeof current).ui.shouldFocusFollowUp = true;
        }
      });

      return create(prev, (draft) => {
        draft.streamStates.set(stream, updatedState);
      });
    });
  },

  // File and output updates
  [PROGRESS_VIEW_COMMANDS.UPDATE_FILES]: (data, ctx) => {
    const { stream, ...update } = data;
    updateWorkflowState(ctx, stream, (prev) =>
      create(prev, (draft) => {
        draft.runFiles = updateNestedRounds(prev.runFiles, update);
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_MISSING_OUTPUTS]: (data, ctx) => {
    const { stream, ...update } = data;
    updateWorkflowState(ctx, stream, (prev) =>
      create(prev, (draft) => {
        draft.runMissingOutputs = updateNestedRounds(
          prev.runMissingOutputs,
          update,
        );
      }),
    );
  },

  // Run-specific updates
  [PROGRESS_VIEW_COMMANDS.UPDATE_INSTRUCTION]: (data, ctx) => {
    const { stream, instruction, runId } = data;
    if (!stream || !runId) return;

    updateWorkflowState(ctx, stream, (prev) =>
      create(prev, (draft) => {
        if (instruction) {
          draft.runInstructions[runId] = instruction;
        } else {
          delete draft.runInstructions[runId];
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_RUN_USAGE]: (data, ctx) => {
    const { stream, runId, usage } = data;
    // Use StreamState.kind as single source of truth for stream type
    ctx.setStreamState(stream, (prev) => {
      if (isToolUseState(prev)) {
        return create(prev, (draft) => {
          draft.runUsage[runId] = usage;
          draft.sessionUsage = sumUsageStats(Object.values(draft.runUsage));
        });
      }
      if (isWorkflowState(prev)) {
        return create(prev, (draft) => {
          draft.runUsage[runId] = usage;
        });
      }
      return prev;
    });
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_CONTEXT_STATE]: (data, ctx) => {
    ctx.setStreamState(data.stream, (prev) =>
      create(prev, (draft) => {
        draft.contextState = data.contextState;
      }),
    );
  },

  // Task group updates
  [PROGRESS_VIEW_COMMANDS.ADD_TASK_GROUP]: (data, ctx) => {
    ctx.setStreamState(data.stream, (prev) =>
      create(prev, (draft) => {
        draft.taskGroups.push(data.group);
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_TASK_GROUP]: (data, ctx) => {
    const { streamId, id, status, endTime } = data.update;
    ctx.setStreamState(streamId, (prev) =>
      create(prev, (draft) => {
        const group = draft.taskGroups.find((g) => g.id === id);
        if (!group) return;
        if (status) group.status = status;
        if (endTime) group.endTime = endTime;
      }),
    );
  },

  // Tool-use specific
  [PROGRESS_VIEW_COMMANDS.UPDATE_TODOS]: (data, ctx) => {
    updateToolUseState(ctx, data.stream, (prev) =>
      create(prev, (draft) => {
        draft.todos = data.todos;
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_QUEUED_FOLLOW_UPS]: (data, ctx) => {
    updateToolUseState(ctx, data.stream, (prev) =>
      create(prev, (draft) => {
        draft.queuedFollowUps = data.messages;
      }),
    );
  },

  // Approval requests
  [PROGRESS_VIEW_COMMANDS.UPDATE_BYPASS]: (data, ctx) => {
    updateToolUseState(ctx, data.stream, (prev) =>
      create(prev, (draft) => {
        if (data.type === 'toolEdit') {
          draft.toolEditBypass = data.bypassActive;
        } else {
          draft.superYoloBypass = data.bypassActive;
        }
      }),
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
      } else {
        addPermission(ctx, {
          kind: permission.kind,
          data: permission.data,
        } as PermissionState);
      }
      return;
    }

    const { kind, id } = data;
    if (kind === PERMISSION_KIND.TOOL_EDIT || kind === PERMISSION_KIND.BASH) {
      removePrompt(ctx, kind, 'requestId', id);
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
    // 1. Logs — shared logic with UPDATE_LOGS
    applyLogUpdate(data, ctx);

    if (!data.stream || data.action === 'clear') return;

    // 2. Todos and queued follow-ups
    if (data.todos || data.queuedFollowUps) {
      updateToolUseState(ctx, data.stream, (prev) =>
        create(prev, (draft) => {
          if (data.todos) draft.todos = data.todos;
          if (data.queuedFollowUps)
            draft.queuedFollowUps = data.queuedFollowUps;
        }),
      );
    }

    // 3. Instruction
    if (data.instruction !== undefined && data.runId) {
      updateWorkflowState(ctx, data.stream, (prev) =>
        create(prev, (draft) => {
          const runId = data.runId as string;
          if (data.instruction) {
            draft.runInstructions[runId] = data.instruction;
          } else {
            delete draft.runInstructions[runId];
          }
        }),
      );
    }

    // 4. Active-stream state (R2: replaces separate syncActiveStreamState messages)
    if (data.conversationProgress || data.badges) {
      ctx.setStreamState(data.stream, (prev) =>
        create(prev, (draft) => {
          if (data.conversationProgress) {
            draft.conversationProgress = data.conversationProgress;
          }
          if (data.badges) {
            draft.activeSubagents = data.badges.activeSubagents;
            draft.finishedSubagentCount = data.badges.finishedSubagentCount;
            draft.activeProcesses = data.badges.activeProcesses;
            draft.finishedProcessCount = data.badges.finishedProcessCount;
          }
        }),
      );
    }
    if (data.parentStreamId !== undefined) {
      ctx.setState((prev) => {
        const target = prev.streamById.get(data.stream as string);
        if (!target || target.parentStreamId === data.parentStreamId)
          return prev;
        const idx = prev.streams.indexOf(target);
        const updated = { ...target, parentStreamId: data.parentStreamId };
        return create(prev, (draft) => {
          draft.streams[idx] = updated;
          draft.streamById.set(data.stream as string, updated);
        });
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

    updateToolUseState(ctx, streamId, (prev) =>
      create(prev, (draft) => {
        if (data.kind === 'polished' && data.text) {
          draft.ui.followUpText = data.text;
          draft.ui.polishedText = data.text;
          draft.ui.polishRevision += 1;
          draft.ui.shouldFocusFollowUp = true;
          return;
        }

        if (data.kind === 'polishError') {
          draft.ui.polishedText = prev.ui.followUpText;
          draft.ui.polishRevision += 1;
          draft.ui.shouldFocusFollowUp = true;
          return;
        }

        if (data.kind === 'transcribed' && data.text) {
          draft.ui.transcribedText = data.text;
          draft.ui.shouldFocusFollowUp = true;
        }
      }),
    );
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

    ctx.setState((prev) =>
      create(prev, (draft) => {
        draft.followupOptionsByStream.set(stream, options);
      }),
    );
  },
};

// ============================================================
// Main dispatcher
// ============================================================

/**
 * Dispatch a typed backend message to its handler.
 *
 * The backend sends ProgressViewOutboundMessage objects via postMessage.
 * TypeScript enforces the shape at compile time, and postMessage uses structured
 * clone (lossless) — no Zod validation needed on the hot path.
 */
export function dispatchMessage(
  message: ProgressViewOutboundMessage,
  ctx: MessageHandlerContext,
): boolean {
  const handler = handlers[message.command] as
    | TypedHandler<typeof message>
    | undefined;

  if (handler) {
    handler(message, ctx);
    return true;
  }

  return false;
}
