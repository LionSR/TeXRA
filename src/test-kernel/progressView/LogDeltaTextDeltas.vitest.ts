import { beforeEach, describe, expect, it } from 'vitest';

import { isStreamingTextLogMessage } from '@progressView/frontend/formatters';
import { logHandlers } from '@progressView/frontend/slices/logSlice';
import {
  appState,
  resetProgressState,
} from '@progressView/frontend/progressState';
import {
  createInitialState,
  type ProgressState,
} from '@progressView/frontend/store';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import {
  AgentCategory,
  LOG_LEVELS,
  MESSAGE_TYPES,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  createStreamState,
  type ProgressViewOutboundHandlerRegistry,
  type ProgressViewOutboundMessage,
  type StreamLogEntry,
  type StreamTabId,
} from '@shared/schemas';
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
  beforeEach(() => {
    resetProgressState();
  });

  it('accepts legacy logDelta messages with no textDeltas field', () => {
    const streamId = 'stream-a' as StreamTabId;
    const state = createInitialState();
    state.activeStreamId = streamId;
    state.streamStates.set(streamId, createStreamState(AgentCategory.Workflow));
    const getState = seedState(state);

    dispatch(logHandlers, {
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId,
      entries: [modelResponseEntry('hello', 'running')],
      updates: [],
    } as unknown as ProgressViewOutboundMessage);

    expect(getState().streamLogs.get(streamId)?.logs[0]?.text).toBe('hello');
  });

  it('appends streamed text without whole-entry replacement and finalizes via full update', () => {
    const streamId = 'stream-a' as StreamTabId;
    const state = createInitialState();
    state.activeStreamId = streamId;
    state.streamStates.set(streamId, createStreamState(AgentCategory.Workflow));
    const getState = seedState(state);

    dispatch(logHandlers, {
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId,
      entries: [modelResponseEntry('hello', 'running')],
      updates: [],
      textDeltas: [],
    });

    dispatch(logHandlers, {
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId,
      entries: [],
      updates: [],
      textDeltas: [{ id: 'model-response', appendText: ' world' }],
    });

    const streamedLogs = getState().streamLogs.get(streamId);
    const streamed = streamedLogs?.logs[0];
    expect(streamed?.text).toBe('hello world');
    expect(streamedLogs?.updatedMessageIndices).toEqual([0]);
    expect(streamed && isStreamingTextLogMessage(streamed)).toBe(true);

    dispatch(logHandlers, {
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId,
      entries: [],
      updates: [modelResponseEntry('hello world', 'completed')],
      textDeltas: [],
    });

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
    const getState = seedState(state);

    dispatch(logHandlers, {
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
    });

    const group = getState().streamStates.get(streamId)?.taskGroups[0];
    expect(group?.status).toBe(STREAM_PHASE.RUNNING);
    expect(group?.kind).toBe('round');
    expect(group?.index).toBe(1);
    expect(group?.total).toBe(3);
  });
});

// #7993 step 3: TaskGroup.status is now the native StreamPhase/RunOutcome
// vocabulary, not the legacy 2-value EndGroupStatus ('stopped'/'error')
// folded down from it. Every GROUP_END row a live/persisted producer writes
// carries the literal RunOutcome ('completed'/'cancelled'/'failed') and
// logSlice.ts's taskGroupEndStatus (a TaskGroupStatusSchema.safeParse
// narrow, not a hand-rolled type guard) now recognizes those directly —
// without that retyping, every canonical GROUP_END row (including a
// failure) would fall through to the STOPPED default, losing the error icon
// and folding completed/cancelled together. The standalone trace-viewer
// still forwards raw legacy entries into this same LOG_DELTA handler
// (replayTrace.ts, §8.3's second, permanent boundary), so logSlice.ts stays
// a tolerant reader of the legacy wire values too — it maps them UP to the
// same native value StreamLogStore.parsePersistedEntries would produce for
// the same on-disk string, rather than going canonical-only.
describe('LOG_DELTA GROUP_END task-group status (#7993 step 3)', () => {
  beforeEach(() => {
    resetProgressState();
  });

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
    // rows are normalized to it at StreamLogStore.parsePersistedEntries) —
    // completed/cancelled stay distinct instead of folding into one bucket,
    // and a failure keeps its own value (the error icon's source).
    ['completed', RUN_OUTCOME.COMPLETED],
    ['cancelled', RUN_OUTCOME.CANCELLED],
    ['failed', RUN_OUTCOME.FAILED],
    // Legacy values the standalone trace-viewer still forwards raw from a
    // pre-cutover exported trace file — never normalized, permanently —
    // map UP to the native value, matching parsePersistedEntries exactly.
    ['stopped', RUN_OUTCOME.COMPLETED],
    ['error', RUN_OUTCOME.FAILED],
    // Malformed/unrecognized data.status falls back to the caller-supplied
    // default, now STREAM_PHASE.COMPLETED (was STREAM_STATUS.STOPPED).
    ['bogus', STREAM_PHASE.COMPLETED],
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
      const getState = seedState(state);

      dispatch(logHandlers, {
        command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
        streamId,
        entries: [groupStartEntry('run-0'), groupEndEntry('run-0', wireStatus)],
        updates: [],
        textDeltas: [],
      });

      const taskGroups = getState().streamStates.get(streamId)?.taskGroups;
      expect(taskGroups?.[0]?.status).toBe(expectedStatus);
    },
  );
});
