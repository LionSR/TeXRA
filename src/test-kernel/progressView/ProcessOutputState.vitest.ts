// Third-party imports
import { create } from 'mutative';
import { describe, expect, it } from 'vitest';

// Local imports - common webview
import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - progress view frontend
import { streamLifecycleHandlers } from '@progressView/frontend/slices/streamLifecycleSlice';
import { streamMetaHandlers } from '@progressView/frontend/slices/streamMetaSlice';
import {
  createInitialState,
  type ProgressState,
  type StreamLogs,
  type StreamState,
} from '@progressView/frontend/store';
import type { MessageHandlerContext } from '@progressView/frontend/messageDispatcher';

// Local imports - shared schemas
import {
  AGENT_CATEGORY,
  createStreamState,
  STREAM_STATUS,
  type ProgressViewOutboundMessage,
  type StreamTabId,
} from '@shared/schemas';

function createContext(initialState: ProgressState): {
  ctx: MessageHandlerContext;
  getState: () => ProgressState;
} {
  let state = initialState;
  const ctx: MessageHandlerContext = {
    getState: () => state,
    setState: (updater) => {
      state = updater(state);
    },
    setStreamState: (streamId, updater) => {
      const current = state.streamStates.get(streamId);
      if (!current) return;
      const updated = updater(current);
      if (updated === current) return;
      state = create(state, (draft) => {
        draft.streamStates.set(streamId, updated);
      });
    },
    setStreamLogs: (
      _streamId,
      _updater: (prev: StreamLogs) => StreamLogs,
    ) => {},
    savePrefs: () => {},
    getPermissions: () => [],
    setPermissions: () => {},
    setPlacement: () => {},
  };
  return { ctx, getState: () => state };
}

function createProcessState(streamId: StreamTabId): ProgressState {
  const state = createInitialState();
  state.activeStreamId = streamId;
  state.streamStates.set(
    streamId,
    createStreamState(AGENT_CATEGORY.WORKFLOW, {
      activeProcesses: [
        {
          executionId: 'active-process',
          agentName: 'bash',
          status: STREAM_STATUS.RUNNING,
        },
      ],
    } satisfies Partial<StreamState>),
  );
  state.processOutputs.set(
    streamId,
    new Map([
      ['active-process', { stdout: 'old-active', stderr: '' }],
      ['stale-process', { stdout: 'old-stale', stderr: '' }],
    ]),
  );
  return state;
}

function dispatch(
  message: ProgressViewOutboundMessage,
  ctx: MessageHandlerContext,
) {
  const handler = streamMetaHandlers[message.command];
  expect(handler).toBeDefined();
  handler?.(message as never, ctx);
}

function dispatchLifecycle(
  message: ProgressViewOutboundMessage,
  ctx: MessageHandlerContext,
) {
  const handler = streamLifecycleHandlers[message.command];
  expect(handler).toBeDefined();
  handler?.(message as never, ctx);
}

describe('process output frontend state', () => {
  it('appends output without pruning sibling process entries', () => {
    const streamId = 'stream-a' as StreamTabId;
    const { ctx, getState } = createContext(createProcessState(streamId));

    dispatch(
      {
        command: PROGRESS_VIEW_COMMANDS.UPDATE_PROCESS_OUTPUT,
        stream: streamId,
        executionId: 'active-process',
        stdout: '-new',
        stderr: 'warn',
      },
      ctx,
    );

    const outputs = getState().processOutputs.get(streamId);
    expect(outputs?.get('active-process')).toEqual({
      stdout: 'old-active-new',
      stderr: 'warn',
    });
    expect(outputs?.get('stale-process')).toEqual({
      stdout: 'old-stale',
      stderr: '',
    });
  });

  it('prunes stale process entries when badges change', () => {
    const streamId = 'stream-a' as StreamTabId;
    const { ctx, getState } = createContext(createProcessState(streamId));

    dispatch(
      {
        command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES,
        stream: streamId,
        activeSubagents: [],
        finishedSubagentCount: 0,
        activeProcesses: [
          {
            executionId: 'active-process',
            agentName: 'bash',
            status: STREAM_STATUS.RUNNING,
          },
        ],
        finishedProcessCount: 0,
      },
      ctx,
    );

    const outputs = getState().processOutputs.get(streamId);
    expect(outputs?.has('active-process')).toBe(true);
    expect(outputs?.has('stale-process')).toBe(false);
  });

  it('clears a stream parent when update parent stream receives null', () => {
    const parent = 'stream-parent' as StreamTabId;
    const child = 'stream-child' as StreamTabId;
    const state = createInitialState();
    state.streamById.set(parent, {
      name: parent,
      label: 'parent',
      agentCategory: AGENT_CATEGORY.WORKFLOW,
      creationTimestamp: 1,
    });
    state.streamById.set(child, {
      name: child,
      label: 'child',
      agentCategory: AGENT_CATEGORY.TOOL_USE,
      creationTimestamp: 2,
      parentStreamId: parent,
    });
    const { ctx, getState } = createContext(state);

    dispatchLifecycle(
      {
        command: PROGRESS_VIEW_COMMANDS.UPDATE_PARENT_STREAM,
        stream: child,
        parentStreamId: null,
      },
      ctx,
    );

    expect(getState().streamById.get(child)?.parentStreamId).toBeUndefined();
  });
});
