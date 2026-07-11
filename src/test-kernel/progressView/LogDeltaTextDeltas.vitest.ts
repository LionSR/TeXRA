import { create } from 'mutative';
import { describe, expect, it } from 'vitest';

import { isStreamingTextLogMessage } from '@progressView/frontend/formatters';
import type {
  HandlerRegistry,
  MessageHandlerContext,
} from '@progressView/frontend/messageHandlerTypes';
import { logHandlers } from '@progressView/frontend/slices/logSlice';
import {
  createInitialState,
  type ProgressState,
  type StreamLogs,
} from '@progressView/frontend/store';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  AgentCategory,
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_STATUS,
  createStreamState,
  type ProgressViewOutboundMessage,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
import { assertSupported } from '@shared/utils/dispatcher';

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

function dispatch(
  handlers: Partial<HandlerRegistry>,
  message: ProgressViewOutboundMessage,
  ctx: MessageHandlerContext,
) {
  const handler = handlers[message.command];
  expect(handler).toBeDefined();
  assertSupported(handler!)(message as never, ctx);
}

function modelResponseEntry(
  text: string,
  status: 'running' | 'completed',
): StreamLogEntry {
  return {
    seqNo: 1,
    id: 'model-response',
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp: 100,
    messageType: MESSAGE_TYPES.MODEL_RESPONSE,
    text,
    data: { status },
  };
}

describe('LOG_DELTA text deltas', () => {
  it('accepts legacy logDelta messages with no textDeltas field', () => {
    const streamId = 'stream-a' as StreamTabId;
    const state = createInitialState();
    state.activeStreamId = streamId;
    state.streamStates.set(streamId, createStreamState(AgentCategory.Workflow));
    const { ctx, getState } = createContext(state);

    dispatch(
      logHandlers,
      {
        command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
        streamId,
        entries: [modelResponseEntry('hello', 'running')],
        updates: [],
      } as unknown as ProgressViewOutboundMessage,
      ctx,
    );

    expect(getState().streamLogs.get(streamId)?.logs[0]?.text).toBe('hello');
  });

  it('appends streamed text without whole-entry replacement and finalizes via full update', () => {
    const streamId = 'stream-a' as StreamTabId;
    const state = createInitialState();
    state.activeStreamId = streamId;
    state.streamStates.set(streamId, createStreamState(AgentCategory.Workflow));
    const { ctx, getState } = createContext(state);

    dispatch(
      logHandlers,
      {
        command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
        streamId,
        entries: [modelResponseEntry('hello', 'running')],
        updates: [],
        textDeltas: [],
      },
      ctx,
    );

    dispatch(
      logHandlers,
      {
        command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
        streamId,
        entries: [],
        updates: [],
        textDeltas: [{ id: 'model-response', appendText: ' world' }],
      },
      ctx,
    );

    const streamedLogs = getState().streamLogs.get(streamId);
    const streamed = streamedLogs?.logs[0];
    expect(streamed?.text).toBe('hello world');
    expect(streamedLogs?.updatedMessageIndices).toEqual([0]);
    expect(streamed && isStreamingTextLogMessage(streamed)).toBe(true);

    dispatch(
      logHandlers,
      {
        command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
        streamId,
        entries: [],
        updates: [modelResponseEntry('hello world', 'completed')],
        textDeltas: [],
      },
      ctx,
    );

    const finalizedLogs = getState().streamLogs.get(streamId);
    const finalized = finalizedLogs?.logs[0];
    expect(finalized?.text).toBe('hello world');
    expect(finalizedLogs?.updatedMessageIndices).toEqual([0]);
    expect(finalized && isStreamingTextLogMessage(finalized)).toBe(false);
  });

  it('keeps valid group-start fields when status is unrecognized', () => {
    const streamId = 'stream-a' as StreamTabId;
    const state = createInitialState();
    state.activeStreamId = streamId;
    state.streamStates.set(streamId, createStreamState(AgentCategory.Workflow));
    const { ctx, getState } = createContext(state);

    dispatch(
      logHandlers,
      {
        command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
        streamId,
        entries: [
          {
            seqNo: 1,
            id: 'group-1',
            type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
            level: LOG_LEVELS.INFO,
            timestamp: 100,
            text: 'Round 1',
            data: { status: 'bogus', kind: 'round', index: 1, total: 3 },
          },
        ],
        updates: [],
        textDeltas: [],
      },
      ctx,
    );

    const group = getState().streamStates.get(streamId)?.taskGroups[0];
    expect(group?.status).toBe(STREAM_STATUS.RUNNING);
    expect(group?.kind).toBe('round');
    expect(group?.index).toBe(1);
    expect(group?.total).toBe(3);
  });
});

// #7993 step 2: every GROUP_END row a live/persisted producer writes now
// carries the literal RunOutcome ('completed'/'cancelled'/'failed'), not the
// folded 2-value EndGroupStatus ('stopped'/'error') logSlice.ts's
// isTaskGroupStatus type guard alone recognizes. Without the read-side fold
// this suite pins, every GROUP_END row — including a failure — would fall
// through to isTaskGroupStatus's STOPPED default, losing the error icon.
// The standalone trace-viewer forwards raw legacy entries into this same
// LOG_DELTA handler (replayTrace.ts, §8.3's second, permanent boundary), so
// the legacy wire values must keep working identically alongside the new
// canonical ones — logSlice.ts stays a tolerant reader of both, it does not
// go canonical-only.
describe('LOG_DELTA GROUP_END task-group status (#7993 step 2)', () => {
  function groupStartEntry(id: string): StreamLogEntry {
    return {
      seqNo: 1,
      id,
      type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      text: 'Run: agent',
      data: { status: 'running' },
    };
  }

  function groupEndEntry(id: string, status: unknown): StreamLogEntry {
    return {
      seqNo: 2,
      id,
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      level: LOG_LEVELS.INFO,
      timestamp: 200,
      text: 'Run: agent',
      data: { status, endTime: 200 },
    };
  }

  it.each([
    // Canonical values every StreamLogStore-sourced GROUP_END row now
    // carries directly (live producers write RunOutcome; persisted legacy
    // rows are normalized to it at StreamLogStore.parsePersistedEntries).
    ['completed', STREAM_STATUS.STOPPED],
    ['cancelled', STREAM_STATUS.STOPPED],
    ['failed', STREAM_STATUS.ERROR],
    // Legacy values the standalone trace-viewer still forwards raw from a
    // pre-cutover exported trace file — never normalized, permanently.
    ['stopped', STREAM_STATUS.STOPPED],
    ['error', STREAM_STATUS.ERROR],
  ] as const)(
    'maps GROUP_END data.status %s to task-group status %s',
    (wireStatus, expectedStatus) => {
      const streamId = 'stream-a' as StreamTabId;
      const state = createInitialState();
      state.activeStreamId = streamId;
      state.streamStates.set(
        streamId,
        createStreamState(AgentCategory.Workflow),
      );
      const { ctx, getState } = createContext(state);

      dispatch(
        logHandlers,
        {
          command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
          streamId,
          entries: [
            groupStartEntry('run-0'),
            groupEndEntry('run-0', wireStatus),
          ],
          updates: [],
          textDeltas: [],
        },
        ctx,
      );

      const taskGroups = getState().streamStates.get(streamId)?.taskGroups;
      expect(taskGroups?.[0]?.status).toBe(expectedStatus);
    },
  );
});
