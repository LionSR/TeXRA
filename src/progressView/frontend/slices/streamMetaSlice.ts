/**
 * Stream metadata handlers: UPDATE_STREAM_STATUS, UPDATE_CONVERSATION_PROGRESS,
 * UPDATE_STREAM_BADGES, UPDATE_PROCESS_OUTPUT.
 */

import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';
import { STREAM_STATUS } from '@shared/schemas';

import { getStreamState, isToolUseState } from '../store';
import type { HandlerRegistry } from '../messageDispatcher';

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

  [PROGRESS_VIEW_COMMANDS.UPDATE_PROCESS_OUTPUT]: (data, ctx) => {
    const { stream, executionId, output } = data;
    ctx.setState((prev) =>
      create(prev, (draft) => {
        let streamOutputs = draft.processOutputs.get(stream);
        if (!streamOutputs) {
          streamOutputs = new Map<string, string>();
          draft.processOutputs.set(stream, streamOutputs);
        }
        const existing = streamOutputs.get(executionId) ?? '';
        const combined = existing + output;
        // Cap at 100KB to prevent unbounded memory growth from chatty processes.
        // Keep the tail so the user sees the most recent output.
        const MAX_OUTPUT = 100_000;
        streamOutputs.set(
          executionId,
          combined.length > MAX_OUTPUT
            ? combined.slice(combined.length - MAX_OUTPUT)
            : combined,
        );
      }),
    );
  },
};
