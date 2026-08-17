import { beforeEach, describe, expect, it } from 'vitest';

import { logHandlers } from '@progressView/frontend/slices/logSlice';
import { streamLifecycleHandlers } from '@progressView/frontend/slices/streamLifecycleSlice';
import { streamMetaHandlers } from '@progressView/frontend/slices/streamMetaSlice';
import { syncHandlers } from '@progressView/frontend/slices/syncSlice';
import {
  appState,
  phaseStages$,
  resetProgressState,
  setStreamStateForId,
  topLevelStreams$,
} from '@progressView/frontend/progressState';
import {
  createInitialState,
  type ProgressState,
} from '@progressView/frontend/store';
import {
  AgentCategory,
  createStreamState,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type ProgressViewOutboundHandlerRegistry,
  type ProgressViewOutboundMessage,
  type StreamLogEntry,
  type StreamStage,
  type StreamState,
  type StreamTabId,
  type StreamTabInfo,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  applyCompactionActivityEntries,
  createCompactionActivityProjection,
  settleCompactionActivities,
  type CompactionActivityProjection,
} from '@shared/streams/compactionActivityProjection';
import { assertSupported } from '@shared/utils/dispatcher';

/** Test-local full replay through the production reducer (the resync path). */
function projectCompactionActivities(
  entries: readonly StreamLogEntry[],
  options: {
    readonly streamTerminal?: boolean;
    readonly settledThroughSeqNo?: number;
  } = {},
): CompactionActivityProjection {
  const projection = createCompactionActivityProjection();
  applyCompactionActivityEntries(projection, entries);
  if (options.streamTerminal) {
    settleCompactionActivities(projection, {
      throughSeqNo: options.settledThroughSeqNo,
    });
  }
  return projection;
}

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

/** A message as the webview receives it, after the postMessage JSON round-trip. */
function overWire(
  message: ProgressViewOutboundMessage,
): ProgressViewOutboundMessage {
  return JSON.parse(JSON.stringify(message)) as ProgressViewOutboundMessage;
}

function registerStream(
  state: ProgressState,
  streamId: StreamTabId,
  overrides: Partial<StreamTabInfo> = {},
): void {
  state.streamById.set(streamId, {
    name: streamId,
    label: streamId,
    agentCategory: AgentCategory.Workflow,
    creationTimestamp: 1,
    ...overrides,
  });
}

/**
 * Seed a single registered workflow stream (optionally with stream state) and
 * return a live reader over the shared appState singleton.
 */
function seedStream(
  streamId: StreamTabId,
  streamState?: Partial<StreamState>,
): () => ProgressState {
  const state = createInitialState();
  registerStream(state, streamId);
  if (streamState) {
    state.streamStates.set(
      streamId,
      createStreamState(AgentCategory.Workflow, streamState),
    );
  }
  return seedState(state);
}

function compactionStartEntry(): StreamLogEntry {
  return {
    seqNo: 1,
    id: 'compaction-start',
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: 'info',
    timestamp: 100,
    messageType: MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY,
    data: {
      activity: 'context_compaction',
      operationId: 'operation-1',
      state: 'started',
    },
  };
}

function startCompaction(streamId: StreamTabId): void {
  dispatch(logHandlers, {
    command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
    streamId,
    entries: [compactionStartEntry()],
    updates: [],
    textDeltas: [],
  });
}

function compactionOutcomeEntry(): StreamLogEntry {
  return {
    seqNo: 2,
    id: 'compaction-outcome',
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: 'info',
    timestamp: 200,
    messageType: MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY,
    data: {
      activity: 'context_compaction',
      operationId: 'operation-1',
      state: 'completed',
    },
  };
}

function compactionStatus(
  state: ProgressState,
  streamId: StreamTabId,
): unknown {
  return state.streamLogs.get(streamId)?.logs[0]?.data;
}

/** A metadata patch as the webview receives it, after the postMessage JSON round-trip. */
function metadataPatchMessage(
  streamId: StreamTabId,
  stage: StreamStage | null,
): ProgressViewOutboundMessage {
  return overWire({
    command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
    streamInfo: {
      name: streamId,
      label: streamId,
      agentCategory: AgentCategory.Workflow,
      creationTimestamp: 1,
    },
    streamState: {
      category: AgentCategory.Workflow,
      status: STREAM_PHASE.RUNNING,
      conversationProgress: {
        toolCallCount: 0,
      },
      stage,
      subagents: [],
    },
  });
}

describe('stream meta frontend state', () => {
  beforeEach(() => {
    resetProgressState();
  });

  it('excludes child streams from the top-level stream list', () => {
    const workflowId = 'workflow' as StreamTabId;
    const toolUseId = 'tool-use' as StreamTabId;
    const childId = 'child' as StreamTabId;
    const state = createInitialState();
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
            childStreamId: 'old-child-stream',
            executionId: 'old-child',
            agentName: 'old child',
            identity: { kind: 'agent' as const, agent: 'old child' },
          },
        ],
      } satisfies Partial<StreamState>),
    );
    const getState = seedState(state);

    dispatch(streamMetaHandlers, {
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
      streamInfo: {
        name: siblingId,
        label: 'search',
        identity: { kind: 'agent', agent: 'search' },
        model: 'deepseekproT',
        agentCategory: AgentCategory.ToolUse,
        creationTimestamp: 2,
      },
      streamState: {
        category: AgentCategory.ToolUse,
        status: STREAM_PHASE.WAITING,
        lastTimestamp: 9,
        conversationProgress: {
          toolCallCount: 3,
        },
        stage: { kind: 'round', index: 1 },
        subagents: [],
      },
      activeStream: siblingId,
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
      stage: { kind: 'round', index: 1 },
      subagents: [],
    });
    expect(getState().activeStreamId).toBe(siblingId);
    expect([...getState().streamById.keys()]).toEqual([siblingId, streamId]);
  });

  it('settles abandoned compaction when restart metadata hydrates to waiting', () => {
    const streamId = 'stream-a' as StreamTabId;
    const getState = seedStream(streamId, { status: STREAM_PHASE.RUNNING });
    startCompaction(streamId);

    dispatch(streamMetaHandlers, {
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA,
      streamInfo: {
        name: streamId,
        label: streamId,
        agentCategory: AgentCategory.Workflow,
        creationTimestamp: 1,
      },
      streamState: {
        category: AgentCategory.Workflow,
        status: STREAM_PHASE.WAITING,
        lastTimestamp: 250,
        conversationProgress: { toolCallCount: 0 },
        subagents: [],
      },
    });

    dispatch(logHandlers, {
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId,
      entries: [],
      updates: [],
      textDeltas: [],
    });

    expect(compactionStatus(getState(), streamId)).toMatchObject({
      status: 'interrupted',
      finalized: true,
      finishedAt: 250,
    });
  });

  it('settles abandoned compaction on a direct waiting status update', () => {
    const streamId = 'stream-a' as StreamTabId;
    const getState = seedStream(streamId, { status: STREAM_PHASE.RUNNING });
    startCompaction(streamId);

    dispatch(streamMetaHandlers, {
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS,
      stream: streamId,
      status: STREAM_PHASE.WAITING,
      logHead: 1,
      lastTimestamp: 300,
    });

    expect(compactionStatus(getState(), streamId)).toMatchObject({
      status: 'interrupted',
      finalized: true,
      finishedAt: 300,
    });
  });

  it('applies a queued provider outcome through the terminal status watermark', () => {
    const streamId = 'stream-a' as StreamTabId;
    const getState = seedStream(streamId, { status: STREAM_PHASE.RUNNING });
    startCompaction(streamId);
    const outcome = compactionOutcomeEntry();

    dispatch(streamMetaHandlers, {
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS,
      stream: streamId,
      status: STREAM_PHASE.WAITING,
      logHead: outcome.seqNo,
      lastTimestamp: 300,
    });
    dispatch(logHandlers, {
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId,
      entries: [outcome],
      updates: [],
      textDeltas: [],
    });

    const replayed = projectCompactionActivities(
      [compactionStartEntry(), outcome],
      { streamTerminal: true, settledThroughSeqNo: outcome.seqNo },
    );
    expect(compactionStatus(getState(), streamId)).toEqual(replayed.blocks[0]);
    expect(compactionStatus(getState(), streamId)).toMatchObject({
      status: 'completed',
      finalized: true,
    });
  });

  it('updates and clears stream substate with status changes', () => {
    const streamId = 'stream-a' as StreamTabId;
    const getState = seedStream(streamId, { status: STREAM_PHASE.RUNNING });

    dispatch(streamMetaHandlers, {
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS,
      stream: streamId,
      status: STREAM_PHASE.RUNNING,
      logHead: 0,
      substate: STREAM_SUBSTATE.STARTING,
    });

    expect(getState().streamStates.get(streamId)?.substate).toBe(
      STREAM_SUBSTATE.STARTING,
    );

    dispatch(streamMetaHandlers, {
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_STATUS,
      stream: streamId,
      status: STREAM_PHASE.COMPLETED,
      logHead: 0,
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
          name: streamId,
          label: 'stream-a',
          agentCategory: AgentCategory.Workflow,
          creationTimestamp: 1,
        },
      ],
      activeStream: streamId,
      streamStates: {
        [streamId]: {
          category: AgentCategory.Workflow,
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
    expect(getState().streamStates.get(streamId)?.substate).toBeUndefined();
  });

  it('clears round stage from a transport-safe metadata patch', () => {
    const streamId = 'stream-a' as StreamTabId;
    const getState = seedStream(streamId, {
      stage: { kind: 'round', index: 2 },
    });

    dispatch(streamMetaHandlers, metadataPatchMessage(streamId, null));

    expect(getState().streamStates.get(streamId)?.stage).toBeUndefined();
  });

  it('merges and clears a phase stage from a transport-safe metadata patch', () => {
    const streamId = 'stream-a' as StreamTabId;
    const getState = seedStream(streamId);

    dispatch(
      streamMetaHandlers,
      metadataPatchMessage(streamId, {
        kind: 'phase',
        label: 'Reduce',
        index: 1,
        total: 3,
      }),
    );
    expect(getState().streamStates.get(streamId)?.stage).toEqual({
      kind: 'phase',
      label: 'Reduce',
      index: 1,
      total: 3,
    });

    dispatch(streamMetaHandlers, metadataPatchMessage(streamId, null));
    expect(getState().streamStates.get(streamId)?.stage).toBeUndefined();
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
        stage: { kind: 'phase', label: 'Reduce', index: 1, total: 3 },
      } satisfies Partial<StreamState>),
    );
    seedState(state);

    const initial = phaseStages$.get();
    expect(initial.get(streamId)).toEqual({
      kind: 'phase',
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
      stage: { kind: 'phase', label: 'Publish', index: 2, total: 3 },
    }));
    const advanced = phaseStages$.get();
    expect(advanced).not.toBe(initial);
    expect(advanced.get(streamId)).toEqual({
      kind: 'phase',
      label: 'Publish',
      index: 2,
      total: 3,
    });

    // A structurally identical value arriving as a fresh object (every
    // metadata patch that crosses postMessage) must not count as a change.
    setStreamStateForId(streamId, (prev) => ({
      ...prev,
      stage: { kind: 'phase', label: 'Publish', index: 2, total: 3 },
    }));
    expect(phaseStages$.get()).toBe(advanced);
  });

  it('clears the stage slot when synced content explicitly clears it', () => {
    const streamId = 'stream-a' as StreamTabId;
    const getState = seedStream(streamId, {
      stage: { kind: 'phase', label: 'Reduce', index: 1, total: 3 },
    });

    const message = overWire({
      command: PROGRESS_VIEW_COMMANDS.SYNC_STREAM_CONTENT,
      stream: streamId,
      action: 'render',
      category: AgentCategory.Workflow,
      runUsage: {},
      outputs: { files: {}, missing: {}, compileFailures: {} },
      activeState: {
        conversationProgress: { toolCallCount: 0 },
        stage: null,
        badges: {
          subagents: [],
        },
      },
    });

    dispatch(syncHandlers, message);

    expect(getState().streamStates.get(streamId)?.stage).toBeUndefined();
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

  it('settles only the latest pending stream selection', () => {
    const first = 'stream-a' as StreamTabId;
    const second = 'stream-b' as StreamTabId;
    const state = createInitialState();
    registerStream(state, first);
    registerStream(state, second);
    state.activeStreamId = first;
    state.pendingStreamSelection = {
      requestId: 'request-new',
      streamId: second,
    };
    const getState = seedState(state);

    dispatch(streamLifecycleHandlers, {
      command: PROGRESS_VIEW_COMMANDS.SETTLE_STREAM_SELECTION,
      requestId: 'request-stale',
      status: 'superseded',
      activeStream: first,
    });
    expect(getState().pendingStreamSelection?.streamId).toBe(second);

    dispatch(streamLifecycleHandlers, {
      command: PROGRESS_VIEW_COMMANDS.SETTLE_STREAM_SELECTION,
      requestId: 'request-new',
      status: 'accepted',
      activeStream: second,
    });
    expect(getState().activeStreamId).toBe(second);
    expect(getState().pendingStreamSelection).toBeNull();
  });

  it('clears transient selection intent on an authoritative roster refresh', () => {
    const first = 'stream-a' as StreamTabId;
    const second = 'stream-b' as StreamTabId;
    const state = createInitialState();
    registerStream(state, first);
    registerStream(state, second);
    state.activeStreamId = first;
    state.pendingStreamSelection = {
      requestId: 'unacknowledged-request',
      streamId: second,
    };
    const getState = seedState(state);

    dispatch(streamLifecycleHandlers, {
      command: PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS,
      streams: [...state.streamById.values()],
      streamStates: {},
      activeStream: first,
    });

    expect(getState().activeStreamId).toBe(first);
    expect(getState().pendingStreamSelection).toBeNull();
  });

  it('releases reloadable content while retaining lightweight state and drafts', () => {
    const stream = 'tool-stream' as StreamTabId;
    const state = createInitialState();
    registerStream(state, stream, { agentCategory: AgentCategory.ToolUse });
    state.streamStates.set(
      stream,
      createStreamState(AgentCategory.ToolUse, {
        status: STREAM_PHASE.WAITING,
        runUsage: {
          run: { inputTokens: 50, outputTokens: 25, cost: 0.01 },
        },
        todos: [
          {
            content: 'Retain the draft',
            status: 'pending',
            activeForm: 'Retaining the draft',
          },
        ],
        ui: {
          followUpText: 'unsent observation',
          polishedText: null,
          polishRevision: 0,
          transcribedText: null,
          recording: false,
          shouldFocusFollowUp: false,
        },
      }),
    );
    const getState = seedState(state);

    dispatch(streamLifecycleHandlers, {
      command: PROGRESS_VIEW_COMMANDS.RELEASE_STREAM_CONTENT,
      stream,
    });

    const released = getState().streamStates.get(stream);
    expect(released).toMatchObject({
      status: STREAM_PHASE.WAITING,
      runUsage: {},
      todos: [],
      ui: { followUpText: 'unsent observation' },
    });
  });
});
