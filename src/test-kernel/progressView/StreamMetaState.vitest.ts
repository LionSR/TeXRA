// Third-party imports
import { beforeEach, describe, expect, it } from 'vitest';

// Local imports
import { streamLifecycleHandlers } from '@progressView/frontend/slices/streamLifecycleSlice';
import { streamMetaHandlers } from '@progressView/frontend/slices/streamMetaSlice';
import { syncHandlers } from '@progressView/frontend/slices/syncSlice';
import {
  appState,
  phaseStages$,
  resetProgressState,
  setStreamStateForId,
  tabStreams$,
  topLevelStreams$,
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
  type ProgressViewOutboundHandlerRegistry,
  type ProgressViewOutboundMessage,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { assertSupported } from '@shared/utils/dispatcher';

/** Seed the shared appState singleton and return a live reader over it. */
function seedState(initialState: ProgressState): () => ProgressState {
  appState.set(initialState);
  return () => appState.get();
}

function dispatch(
  handlers: Partial<ProgressViewOutboundHandlerRegistry>,
  message: ProgressViewOutboundMessage,
) {
  const handler = handlers[message.command];
  expect(handler).toBeDefined();
  assertSupported(handler!)(message as never);
}

function registerStream(
  state: ProgressState,
  streamId: StreamTabId,
  overrides: Partial<Extract<StreamTabInfo, { kind: 'agent' }>> = {},
): void {
  state.streamById.set(streamId, {
    kind: 'agent',
    name: streamId,
    label: streamId,
    agentCategory: AgentCategory.Workflow,
    creationTimestamp: 1,
    ...overrides,
  });
}

describe('stream meta frontend state', () => {
  beforeEach(() => {
    resetProgressState();
  });

  it('keeps the unfiltered top-level stream list independent of the progress filter', () => {
    const workflowId = 'workflow' as StreamTabId;
    const toolUseId = 'tool-use' as StreamTabId;
    const childId = 'child' as StreamTabId;
    const state = createInitialState();
    state.streamFilter = 'workflow';
    registerStream(state, workflowId);
    registerStream(state, toolUseId, {
      agentCategory: AgentCategory.ToolUse,
      creationTimestamp: 2,
    });
    registerStream(state, childId, {
      agentCategory: AgentCategory.ToolUse,
      creationTimestamp: 3,
      parentStreamId: workflowId,
    });
    seedState(state);

    expect(tabStreams$.get().map((stream) => stream.name)).toEqual([
      workflowId,
    ]);
    expect(topLevelStreams$.get().map((stream) => stream.name)).toEqual([
      workflowId,
      toolUseId,
    ]);
  });

  it('patches one stream metadata record without replacing siblings', () => {
    const streamId = 'stream-a' as StreamTabId;
    const siblingId = 'stream-b' as StreamTabId;
    const state = createInitialState();
    state.activeStreamId = streamId;
    state.streamFilter = 'workflow';
    registerStream(state, siblingId, {
      label: 'old sibling',
      agentCategory: AgentCategory.ToolUse,
      creationTimestamp: 2,
    });
    registerStream(state, streamId);
    state.streamStates.set(streamId, createStreamState(AgentCategory.Workflow));
    state.streamStates.set(
      siblingId,
      createStreamState(AgentCategory.ToolUse, {
        status: STREAM_PHASE.RUNNING,
        subagents: [
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
        subagents: [],
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
      subagents: [],
    });
    expect(getState().activeStreamId).toBe(siblingId);
    expect(getState().streamFilter).toBe('workflow');
    expect([...getState().streamById.keys()]).toEqual([siblingId, streamId]);
  });

  it('updates and clears stream substate with status changes', () => {
    const streamId = 'stream-a' as StreamTabId;
    const state = createInitialState();
    registerStream(state, streamId);
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
    state.streamFilter = 'workflow';
    registerStream(state, streamId);
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
          subagents: [],
        },
      },
    });

    expect(getState().streamStates.get(streamId)?.status).toBe(
      STREAM_PHASE.COMPLETED,
    );
    expect(getState().streamFilter).toBe('workflow');
    expect(getState().streamStates.get(streamId)?.substate).toBeUndefined();
  });

  it('clears round stage from a transport-safe metadata patch', () => {
    const streamId = 'stream-a' as StreamTabId;
    const state = createInitialState();
    registerStream(state, streamId);
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
          subagents: [],
        },
      } satisfies ProgressViewOutboundMessage),
    ) as ProgressViewOutboundMessage;

    dispatch(streamMetaHandlers, message);

    expect(getState().streamStates.get(streamId)?.roundStage).toBeUndefined();
  });

  it('merges and clears a phase stage from a transport-safe metadata patch', () => {
    const streamId = 'stream-a' as StreamTabId;
    const state = createInitialState();
    registerStream(state, streamId);
    const getState = seedState(state);

    const patch = (
      phaseStage: { label: string; index?: number; total?: number } | null,
    ): ProgressViewOutboundMessage =>
      JSON.parse(
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
            phaseStage,
            subagents: [],
          },
        } satisfies ProgressViewOutboundMessage),
      ) as ProgressViewOutboundMessage;

    dispatch(
      streamMetaHandlers,
      patch({ label: 'Reduce', index: 1, total: 3 }),
    );
    expect(getState().streamStates.get(streamId)?.phaseStage).toEqual({
      label: 'Reduce',
      index: 1,
      total: 3,
    });

    dispatch(streamMetaHandlers, patch(null));
    expect(getState().streamStates.get(streamId)?.phaseStage).toBeUndefined();
  });

  it('keeps the phase-stage projection stable across unrelated stream ticks', () => {
    const streamId = 'stream-a' as StreamTabId;
    const otherId = 'stream-b' as StreamTabId;
    const state = createInitialState();
    registerStream(state, streamId);
    registerStream(state, otherId);
    state.streamStates.set(
      streamId,
      createStreamState(AgentCategory.Workflow, {
        phaseStage: { label: 'Reduce', index: 1, total: 3 },
      } satisfies Partial<StreamState>),
    );
    seedState(state);

    const initial = phaseStages$.get();
    expect(initial.get(streamId)).toEqual({
      label: 'Reduce',
      index: 1,
      total: 3,
    });

    // An unrelated stream's progress tick rebuilds streamStates, so the
    // projection recomputes — but its identity must not change, or every
    // consumer re-renders on a tick that touched no phase.
    setStreamStateForId(otherId, (prev) => ({
      ...prev,
      conversationProgress: { toolCallCount: 7 },
    }));
    expect(phaseStages$.get()).toBe(initial);

    // A real phase advance does change identity.
    setStreamStateForId(streamId, (prev) => ({
      ...prev,
      phaseStage: { label: 'Publish', index: 2, total: 3 },
    }));
    const advanced = phaseStages$.get();
    expect(advanced).not.toBe(initial);
    expect(advanced.get(streamId)).toEqual({
      label: 'Publish',
      index: 2,
      total: 3,
    });

    // A structurally identical value arriving as a fresh object (every
    // metadata patch that crosses postMessage) must not count as a change.
    setStreamStateForId(streamId, (prev) => ({
      ...prev,
      phaseStage: { label: 'Publish', index: 2, total: 3 },
    }));
    expect(phaseStages$.get()).toBe(advanced);
  });

  it('clears round and phase stage when synced content explicitly clears them', () => {
    const streamId = 'stream-a' as StreamTabId;
    const state = createInitialState();
    registerStream(state, streamId);
    state.streamStates.set(
      streamId,
      createStreamState(AgentCategory.Workflow, {
        roundStage: { index: 2 },
        phaseStage: { label: 'Reduce', index: 1, total: 3 },
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
          phaseStage: null,
          badges: {
            subagents: [],
          },
          parentStreamId: null,
        },
      } satisfies ProgressViewOutboundMessage),
    ) as ProgressViewOutboundMessage;

    dispatch(syncHandlers, message);

    expect(getState().streamStates.get(streamId)?.roundStage).toBeUndefined();
    expect(getState().streamStates.get(streamId)?.phaseStage).toBeUndefined();
  });

  it('honors an explicit empty active-stream selection', () => {
    const streamId = 'stream-a' as StreamTabId;
    const state = createInitialState();
    state.activeStreamId = streamId;
    registerStream(state, streamId);
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
    registerStream(state, parent);
    registerStream(state, child, {
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
