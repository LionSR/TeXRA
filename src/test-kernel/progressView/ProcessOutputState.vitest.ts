// Third-party imports
import { beforeEach, describe, expect, it } from 'vitest';

// Local imports - progress view frontend
import { streamLifecycleHandlers } from '@progressView/frontend/slices/streamLifecycleSlice';
import { streamMetaHandlers } from '@progressView/frontend/slices/streamMetaSlice';
import { syncHandlers } from '@progressView/frontend/slices/syncSlice';
import {
  appState,
  resetProgressState,
} from '@progressView/frontend/progressState';
import {
  createInitialState,
  type ProgressState,
  type StreamState,
} from '@progressView/frontend/store';
import {
  AgentCategory,
  createStreamState,
  STREAM_PHASE,
  STREAM_SUBSTATE,
  STREAM_STATUS,
  type ProgressViewOutboundHandlerRegistry,
  type ProgressViewOutboundMessage,
  type StreamTabId,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { assertSupported } from '@shared/utils/dispatcher';

// Local imports - shared schemas

/** Seed the shared appState singleton and return a live reader over it. */
function seedState(initialState: ProgressState): () => ProgressState {
  appState.set(initialState);
  return () => appState.get();
}

function createProcessState(streamId: StreamTabId): ProgressState {
  const state = createInitialState();
  state.activeStreamId = streamId;
  state.streamStates.set(
    streamId,
    createStreamState(AgentCategory.Workflow, {
      activeProcesses: [
        {
          kind: 'process',
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
  handlers: Partial<ProgressViewOutboundHandlerRegistry>,
  message: ProgressViewOutboundMessage,
) {
  const handler = handlers[message.command];
  expect(handler).toBeDefined();
  assertSupported(handler!)(message as never);
}

function registerWorkflowStream(
  state: ProgressState,
  streamId: StreamTabId,
): void {
  state.streamById.set(streamId, {
    kind: 'agent',
    name: streamId,
    label: 'stream-a',
    agentCategory: AgentCategory.Workflow,
    creationTimestamp: 1,
  });
}

describe('process output frontend state', () => {
  beforeEach(() => {
    resetProgressState();
  });

  it('patches one stream metadata record without replacing siblings', () => {
    const streamId = 'stream-a' as StreamTabId;
    const siblingId = 'stream-b' as StreamTabId;
    const state = createInitialState();
    state.activeStreamId = streamId;
    state.streamFilter = 'workflow';
    state.streamById.set(siblingId, {
      kind: 'agent',
      name: siblingId,
      label: 'old sibling',
      agentCategory: AgentCategory.ToolUse,
      creationTimestamp: 2,
    });
    registerWorkflowStream(state, streamId);
    state.streamStates.set(streamId, createStreamState(AgentCategory.Workflow));
    state.streamStates.set(
      siblingId,
      createStreamState(AgentCategory.ToolUse, {
        status: STREAM_PHASE.RUNNING,
        activeSubagents: [
          {
            kind: 'subagent',
            childStreamId: 'old-child-stream',
            executionId: 'old-child',
            agentName: 'old child',
          },
        ],
      } satisfies Partial<StreamState>),
    );
    const getState = seedState(state);

    dispatch(streamMetaHandlers, {
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
      streamInfo: {
        kind: 'agent',
        name: siblingId,
        label: 'search',
        agent: 'search',
        model: 'deepseekproT',
        agentCategory: AgentCategory.ToolUse,
        creationTimestamp: 2,
      },
      streamState: {
        kind: AgentCategory.ToolUse,
        status: STREAM_PHASE.WAITING,
        lastTimestamp: 9,
        conversationProgress: {
          toolCallCount: 3,
        },
        roundStage: { index: 1 },
        activeSubagents: [],
        finishedSubagentCount: 1,
        activeProcesses: [
          {
            kind: 'process',
            executionId: 'process-a',
            agentName: 'bash',
          },
        ],
        finishedProcessCount: 0,
      },
      activeStream: siblingId,
      agentFilter: 'toolUse',
    });

    expect(getState().streamById.get(streamId)?.label).toBe('stream-a');
    expect(getState().streamById.get(siblingId)).toMatchObject({
      label: 'search',
      model: 'deepseekproT',
    });
    expect(getState().streamStates.get(siblingId)).toMatchObject({
      status: STREAM_PHASE.WAITING,
      lastTimestamp: 9,
      conversationProgress: {
        toolCallCount: 3,
      },
      roundStage: { index: 1 },
      finishedSubagentCount: 1,
      activeProcesses: [
        {
          kind: 'process',
          executionId: 'process-a',
          agentName: 'bash',
        },
      ],
    });
    expect(getState().activeStreamId).toBe(siblingId);
    expect(getState().streamFilter).toBe('toolUse');
    expect([...getState().streamById.keys()]).toEqual([siblingId, streamId]);
  });

  it('appends output without pruning sibling process entries', () => {
    const streamId = 'stream-a' as StreamTabId;
    const getState = seedState(createProcessState(streamId));

    dispatch(streamMetaHandlers, {
      command: PROGRESS_VIEW_COMMANDS.UPDATE_PROCESS_OUTPUT,
      stream: streamId,
      executionId: 'active-process',
      stdout: '-new',
      stderr: 'warn',
    });

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
    const getState = seedState(createProcessState(streamId));

    dispatch(streamMetaHandlers, {
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES,
      stream: streamId,
      activeSubagents: [],
      finishedSubagentCount: 0,
      activeProcesses: [
        {
          kind: 'process',
          executionId: 'active-process',
          agentName: 'bash',
          status: STREAM_STATUS.RUNNING,
        },
      ],
      finishedProcessCount: 0,
    });

    const outputs = getState().processOutputs.get(streamId);
    expect(outputs?.has('active-process')).toBe(true);
    expect(outputs?.has('stale-process')).toBe(false);
  });

  it('updates and clears stream substate with status changes', () => {
    const streamId = 'stream-a' as StreamTabId;
    const state = createInitialState();
    registerWorkflowStream(state, streamId);
    state.streamStates.set(
      streamId,
      createStreamState(AgentCategory.Workflow, {
        status: STREAM_PHASE.RUNNING,
      } satisfies Partial<StreamState>),
    );
    const getState = seedState(state);

    dispatch(streamMetaHandlers, {
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS,
      stream: streamId,
      status: STREAM_PHASE.RUNNING,
      substate: STREAM_SUBSTATE.STARTING,
    });

    expect(getState().streamStates.get(streamId)?.substate).toBe(
      STREAM_SUBSTATE.STARTING,
    );

    dispatch(streamMetaHandlers, {
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS,
      stream: streamId,
      status: STREAM_PHASE.COMPLETED,
    });

    expect(getState().streamStates.get(streamId)?.status).toBe(
      STREAM_PHASE.COMPLETED,
    );
    expect(getState().streamStates.get(streamId)?.substate).toBeUndefined();
  });

  it('clears stream substate when full metadata sync omits it', () => {
    const streamId = 'stream-a' as StreamTabId;
    const state = createInitialState();
    state.activeStreamId = streamId;
    registerWorkflowStream(state, streamId);
    state.streamStates.set(
      streamId,
      createStreamState(AgentCategory.Workflow, {
        status: STREAM_PHASE.RUNNING,
        substate: STREAM_SUBSTATE.STARTING,
      } satisfies Partial<StreamState>),
    );
    const getState = seedState(state);

    dispatch(streamLifecycleHandlers, {
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      streams: [
        {
          kind: 'agent',
          name: streamId,
          label: 'stream-a',
          agentCategory: AgentCategory.Workflow,
          creationTimestamp: 1,
        },
      ],
      activeStream: streamId,
      agentFilter: 'all',
      streamStates: {
        [streamId]: {
          kind: AgentCategory.Workflow,
          status: STREAM_PHASE.COMPLETED,
          lastTimestamp: 2,
          conversationProgress: {
            toolCallCount: 0,
          },
          activeSubagents: [],
          finishedSubagentCount: 0,
          activeProcesses: [],
          finishedProcessCount: 0,
        },
      },
    });

    expect(getState().streamStates.get(streamId)?.status).toBe(
      STREAM_PHASE.COMPLETED,
    );
    expect(getState().streamStates.get(streamId)?.substate).toBeUndefined();
  });

  it('clears round stage from a transport-safe metadata patch', () => {
    const streamId = 'stream-a' as StreamTabId;
    const state = createInitialState();
    registerWorkflowStream(state, streamId);
    state.streamStates.set(
      streamId,
      createStreamState(AgentCategory.Workflow, {
        roundStage: { index: 2 },
      } satisfies Partial<StreamState>),
    );
    const getState = seedState(state);

    const message = JSON.parse(
      JSON.stringify({
        command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
        streamInfo: {
          name: streamId,
          label: 'stream-a',
          kind: 'agent',
          agentCategory: AgentCategory.Workflow,
          creationTimestamp: 1,
        },
        streamState: {
          kind: AgentCategory.Workflow,
          status: STREAM_PHASE.RUNNING,
          conversationProgress: {
            toolCallCount: 0,
          },
          roundStage: null,
          activeSubagents: [],
          finishedSubagentCount: 0,
          activeProcesses: [],
          finishedProcessCount: 0,
        },
      } satisfies ProgressViewOutboundMessage),
    ) as ProgressViewOutboundMessage;

    dispatch(streamMetaHandlers, message);

    expect(getState().streamStates.get(streamId)?.roundStage).toBeUndefined();
  });

  it('clears round stage when synced content explicitly clears it', () => {
    const streamId = 'stream-a' as StreamTabId;
    const state = createInitialState();
    registerWorkflowStream(state, streamId);
    state.streamStates.set(
      streamId,
      createStreamState(AgentCategory.Workflow, {
        roundStage: { index: 2 },
      } satisfies Partial<StreamState>),
    );
    const getState = seedState(state);

    const message = JSON.parse(
      JSON.stringify({
        command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
        stream: streamId,
        action: 'render',
        kind: AgentCategory.Workflow,
        runUsage: {},
        outputs: { files: {}, missing: {}, compileFailures: {} },
        activeState: {
          conversationProgress: { toolCallCount: 0 },
          roundStage: null,
          badges: {
            activeSubagents: [],
            finishedSubagentCount: 0,
            activeProcesses: [],
            finishedProcessCount: 0,
          },
          parentStreamId: null,
        },
      } satisfies ProgressViewOutboundMessage),
    ) as ProgressViewOutboundMessage;

    dispatch(syncHandlers, message);

    expect(getState().streamStates.get(streamId)?.roundStage).toBeUndefined();
  });

  it('honors an explicit empty active-stream selection', () => {
    const streamId = 'stream-a' as StreamTabId;
    const state = createInitialState();
    state.activeStreamId = streamId;
    registerWorkflowStream(state, streamId);
    const getState = seedState(state);

    dispatch(streamLifecycleHandlers, {
      command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
      activeStream: '',
    });

    expect(getState().activeStreamId).toBeNull();
  });

  it('clears a stream parent when update parent stream receives null', () => {
    const parent = 'stream-parent' as StreamTabId;
    const child = 'stream-child' as StreamTabId;
    const state = createInitialState();
    state.streamById.set(parent, {
      kind: 'agent',
      name: parent,
      label: 'parent',
      agentCategory: AgentCategory.Workflow,
      creationTimestamp: 1,
    });
    state.streamById.set(child, {
      kind: 'agent',
      name: child,
      label: 'child',
      agentCategory: AgentCategory.ToolUse,
      creationTimestamp: 2,
      parentStreamId: parent,
    });
    const getState = seedState(state);

    dispatch(streamLifecycleHandlers, {
      command: PROGRESS_VIEW_COMMANDS.UPDATE_PARENT_STREAM,
      stream: child,
      parentStreamId: null,
    });

    expect(getState().streamById.get(child)?.parentStreamId).toBeUndefined();
  });
});
