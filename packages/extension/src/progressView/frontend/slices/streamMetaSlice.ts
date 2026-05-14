/**
 * Stream metadata handlers: UPDATE_STREAM_STATUS, UPDATE_STREAM_DESCRIPTION,
 * UPDATE_CONVERSATION_PROGRESS, UPDATE_STREAM_BADGES, UPDATE_PROCESS_OUTPUT.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import { STREAM_STATUS, type StreamTabId } from '@shared/schemas';

import { getStreamState, isToolUseState } from '../store';
import type {
  HandlerRegistry,
  MessageHandlerContext,
} from '../messageDispatcher';

/**
 * Buffer for subagent descriptions that race their own UPDATE_STREAMS
 * registration. Lives as module state because it's purely transient plumbing
 * between two slices, not state the UI needs to observe.
 */
export const pendingDescriptions = new Map<StreamTabId, string>();

export function takePendingDescription(
  streamId: StreamTabId,
): string | undefined {
  const desc = pendingDescriptions.get(streamId);
  if (desc !== undefined) pendingDescriptions.delete(streamId);
  return desc;
}

/** Max characters retained per output stream (stdout/stderr) per process. */
const MAX_OUTPUT = 100_000;
/** Trim below the cap so new output can append for a while before the next reset. */
const TRIMMED_OUTPUT_LENGTH = 80_000;

/** Append delta to prev, trimming below MAX_OUTPUT when the cap is crossed. */
function capOutput(prev: string, delta: string): string {
  if (!delta) return prev;
  const combined = prev + delta;
  return combined.length > MAX_OUTPUT
    ? combined.slice(combined.length - TRIMMED_OUTPUT_LENGTH)
    : combined;
}

/** Remove output entries for processes no longer in the active list. */
function pruneStaleOutputs(
  ctx: MessageHandlerContext,
  stream: string,
  activeIds: Set<string>,
): void {
  ctx.setState((prev) => {
    const streamOutputs = prev.processOutputs.get(stream);
    if (!streamOutputs) return prev;
    let hasStale = false;
    for (const id of streamOutputs.keys()) {
      if (!activeIds.has(id)) {
        hasStale = true;
        break;
      }
    }
    if (!hasStale) return prev;
    return create(prev, (draft) => {
      const outputs = draft.processOutputs.get(stream);
      if (!outputs) return;
      for (const id of [...outputs.keys()]) {
        if (!activeIds.has(id)) outputs.delete(id);
      }
    });
  });
}

export const streamMetaHandlers: HandlerRegistry = {
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

  [PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_DESCRIPTION]: (data, ctx) => {
    const { stream, description } = data;
    // Subagent description can race its own UPDATE_STREAMS registration; if
    // the stream isn't in streamById yet, buffer out-of-band so
    // streamLifecycleSlice can drain it on arrival. Side effect lives
    // outside the state updater so updater stays pure.
    if (!ctx.getState().streamById.has(stream)) {
      pendingDescriptions.set(stream, description);
      return;
    }
    ctx.setState((prev) =>
      create(prev, (draft) => {
        const existing = draft.streamById.get(stream);
        // Replace via set() so the Map value identity changes and selectors
        // observing streamById propagate the update (mirrors the pattern in
        // stateUtils.updateParentStreamId).
        if (existing) {
          draft.streamById.set(stream, { ...existing, description });
        }
      }),
    );
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
    pruneStaleOutputs(
      ctx,
      data.stream,
      new Set(
        data.activeProcesses.map((p: { executionId: string }) => p.executionId),
      ),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_PROCESS_OUTPUT]: (data, ctx) => {
    const { stream, executionId, stdout, stderr } = data;
    ctx.setState((prev) => {
      // Only prune stale entries when this stream is active — badge data
      // (activeProcesses) is only refreshed for the active stream, so for
      // inactive streams the set would be stale and we'd incorrectly delete
      // output for still-running sibling processes. For inactive streams,
      // pruning is handled by UPDATE_STREAM_BADGES when the user switches back.
      const isActiveStream = prev.activeStreamId === stream;
      return create(prev, (draft) => {
        let streamOutputs = draft.processOutputs.get(stream);
        if (!streamOutputs) {
          streamOutputs = new Map();
          draft.processOutputs.set(stream, streamOutputs);
        }
        if (isActiveStream) {
          const streamState = prev.streamStates.get(stream);
          const activeIds = new Set(
            (streamState?.activeProcesses ?? []).map(
              (p: { executionId: string }) => p.executionId,
            ),
          );
          for (const id of [...streamOutputs.keys()]) {
            if (id !== executionId && !activeIds.has(id))
              streamOutputs.delete(id);
          }
        }
        const existing = streamOutputs.get(executionId) ?? {
          stdout: '',
          stderr: '',
        };
        streamOutputs.set(executionId, {
          stdout: capOutput(existing.stdout, stdout),
          stderr: capOutput(existing.stderr, stderr),
        });
      });
    });
  },
};
