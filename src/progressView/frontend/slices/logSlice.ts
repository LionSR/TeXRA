/**
 * Log message handlers: APPEND_LOG, UPDATE_LOG, UPDATE_LOGS.
 *
 * Owns the pendingLogUpdates Map and associated helpers.
 */

import { create } from 'mutative';

import {
  sumUsageStats,
  type LogMessageData,
  type LogsPayload,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

import {
  createStreamLogs,
  isToolUseState,
  isWorkflowState,
  type StreamState,
} from '../store';
import type {
  HandlerRegistry,
  MessageHandlerContext,
} from '../messageDispatcher';

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
// Helpers (exported for use by other slices)
// ============================================================

function getPendingLogKey(streamId: string, logId: string): string {
  return `${streamId}:${logId}`;
}

export function clearPendingLogUpdatesForStream(streamId: string): void {
  const prefix = `${streamId}:`;
  for (const key of pendingLogUpdates.keys()) {
    if (key.startsWith(prefix)) {
      pendingLogUpdates.delete(key);
    }
  }
}

export function clearAllPendingLogUpdates(): void {
  pendingLogUpdates.clear();
}

/**
 * Shared log-update logic used by both UPDATE_LOGS and SYNC_STREAM_CONTENT.
 * Extracted to avoid the handler-calls-handler pattern with synthetic messages.
 */
export function applyLogUpdate(
  data: LogsPayload,
  ctx: MessageHandlerContext,
): void {
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

// ============================================================
// Handlers
// ============================================================

export const logHandlers: HandlerRegistry = {
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
};
