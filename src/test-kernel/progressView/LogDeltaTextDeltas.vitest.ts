import { beforeEach, describe, expect, it } from 'vitest';

import { logHandlers } from '@progressView/frontend/slices/logSlice';
import {
  appState,
  resetProgressState,
} from '@progressView/frontend/progressState';
import {
  createInitialState,
  type ProgressState,
} from '@progressView/frontend/store';
import {
  AgentCategory,
  LOG_LEVELS,
  MESSAGE_TYPES,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  ProgressViewOutboundMessageSchema,
  StreamLogEntrySchema,
  createStreamState,
  type ProgressViewOutboundHandlerRegistry,
  type ProgressViewOutboundMessage,
  type StreamLogEntry,
  type StreamLogTextDelta,
  type TaskGroup,
  type StreamTabId,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { TranscriptRow } from '@shared/transcript';
import { upsertTaskGroupFromStreamLog } from '@shared/streams/taskGroupProjection';
import { assertSupported } from '@shared/utils/dispatcher';

/** The painted text of any text-bearing row. */
function rowText(row: TranscriptRow | undefined): string | undefined {
  return row && 'text' in row ? row.text.full : undefined;
}

/** Test-local full replay through the production reducer (the resync path). */
function projectTaskGroupsFromStreamLog(
  entries: Iterable<StreamLogEntry>,
): TaskGroup[] {
  const taskGroups: TaskGroup[] = [];
  const taskGroupIndex = new Map<string, number>();
  for (const entry of entries) {
    upsertTaskGroupFromStreamLog(taskGroups, taskGroupIndex, entry);
  }
  return taskGroups;
}

const STREAM_ID = 'stream-a' as StreamTabId;

/**
 * Seed the shared appState singleton with an active workflow stream and return
 * a live reader over it.
 */
function seedWorkflowStream(): () => ProgressState {
  const state = createInitialState();
  state.activeStreamId = STREAM_ID;
  state.streamStates.set(STREAM_ID, createStreamState(AgentCategory.Workflow));
  appState.set(state);
  return () => appState.get();
}

const handlers: Partial<ProgressViewOutboundHandlerRegistry> = logHandlers;

function dispatch(message: ProgressViewOutboundMessage) {
  const parsed = ProgressViewOutboundMessageSchema.parse(message);
  const handler = handlers[parsed.command];
  expect(handler).toBeDefined();
  assertSupported(handler!)(parsed as never);
}

function dispatchLogDelta(
  entries: StreamLogEntry[],
  options: {
    updates?: StreamLogEntry[];
    textDeltas?: StreamLogTextDelta[];
  } = {},
) {
  dispatch({
    command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
    streamId: STREAM_ID,
    entries,
    updates: options.updates ?? [],
    textDeltas: options.textDeltas ?? [],
  });
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
    const getState = seedWorkflowStream();

    dispatch({
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId: STREAM_ID,
      entries: [modelResponseEntry('hello', 'running')],
      updates: [],
    } as unknown as ProgressViewOutboundMessage);

    expect(rowText(getState().streamLogs.get(STREAM_ID)?.rows[0])).toBe(
      'hello',
    );
  });

  it('recovers malformed rows without discarding their live delta batch', () => {
    const getState = seedWorkflowStream();

    const parsed = ProgressViewOutboundMessageSchema.parse({
      command: PROGRESS_VIEW_COMMANDS.LOG_DELTA,
      streamId: STREAM_ID,
      entries: [
        {
          seqNo: 1,
          id: 'malformed-file-list',
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          level: LOG_LEVELS.INFO,
          timestamp: 100,
          messageType: MESSAGE_TYPES.FILE_LIST,
          text: 'files',
          data: [{ name: 'missing required path and ok fields' }],
        },
        modelResponseEntry('still delivered', 'completed'),
      ],
    });

    const handler = handlers[parsed.command];
    assertSupported(handler!)(parsed as never);

    const rows = getState().streamLogs.get(STREAM_ID)?.rows;
    expect(rows).toHaveLength(2);
    expect(rows?.map(rowText)).toEqual(['files', 'still delivered']);
    expect(rows?.[0]?.messageType).toBe(MESSAGE_TYPES.DEFAULT);
  });

  it('appends streamed text without whole-entry replacement and finalizes via full update', () => {
    const getState = seedWorkflowStream();

    dispatchLogDelta([modelResponseEntry('hello', 'running')]);

    dispatchLogDelta([], {
      textDeltas: [{ id: 'model-response', appendText: ' world' }],
    });

    const streamedLogs = getState().streamLogs.get(STREAM_ID);
    const streamed = streamedLogs?.rows[0];
    expect(rowText(streamed)).toBe('hello world');
    expect(streamedLogs?.updatedRowIndices).toEqual([0]);
    expect(streamed?.kind === 'assistant' && streamed.streaming).toBe(true);

    dispatchLogDelta([], {
      updates: [modelResponseEntry('hello world', 'completed')],
    });

    const finalizedLogs = getState().streamLogs.get(STREAM_ID);
    const finalized = finalizedLogs?.rows[0];
    expect(rowText(finalized)).toBe('hello world');
    expect(finalizedLogs?.updatedRowIndices).toEqual([0]);
    expect(finalized?.kind === 'assistant' && finalized.streaming).toBe(false);
  });

  it('projects compaction start and terminal events into one stable row', () => {
    const getState = seedWorkflowStream();
    const activityEntry = (
      seqNo: number,
      state: 'started' | 'completed',
    ): StreamLogEntry => ({
      seqNo,
      id: `compaction-event-${seqNo}`,
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: seqNo * 100,
      messageType: MESSAGE_TYPES.CONTEXT_COMPACTION_ACTIVITY,
      text: `compaction ${state}`,
      data: {
        activity: 'context_compaction',
        operationId: 'operation-1',
        state,
      },
    });

    dispatchLogDelta([activityEntry(1, 'started')]);
    expect(getState().streamLogs.get(STREAM_ID)?.rows).toEqual([
      expect.objectContaining({
        id: 'compaction:operation-1',
        block: expect.objectContaining({ status: 'running' }),
      }),
    ]);

    dispatchLogDelta([
      {
        seqNo: 2,
        id: 'later-user-message',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 200,
        messageType: MESSAGE_TYPES.USER_MESSAGE,
        text: 'Continue',
      },
    ]);
    expect(getState().streamLogs.get(STREAM_ID)?.rows[0]).toMatchObject({
      id: 'compaction:operation-1',
      block: { status: 'interrupted', finalized: false },
    });

    dispatchLogDelta([activityEntry(3, 'completed')]);
    const streamLogs = getState().streamLogs.get(STREAM_ID);
    expect(streamLogs?.rows).toHaveLength(2);
    expect(streamLogs?.rows[0]).toMatchObject({
      id: 'compaction:operation-1',
      block: {
        status: 'completed',
        finalized: true,
        operationId: 'operation-1',
      },
    });
    expect(streamLogs?.updatedRowIndices).toEqual([0]);
  });
});

// #7993 step 3: GROUP_END data.status is the native RunOutcome vocabulary
// ('completed'/'cancelled'/'failed'). Legacy values the trace-viewer still
// forwards raw ('stopped'/'error') map up to the native values
// StreamLogStore.parsePersistedEntries would produce.
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
    return StreamLogEntrySchema.parse({
      seqNo: 2,
      id,
      type: STREAM_LOG_ENTRY_TYPES.GROUP_END,
      level: LOG_LEVELS.INFO,
      timestamp: 200,
      text: 'Run: agent',
      data: { status, endTime: 200 },
    });
  }

  it.each([
    // Canonical RunOutcome values and legacy trace-viewer values mapped up.
    ['completed', RUN_OUTCOME.COMPLETED],
    ['cancelled', RUN_OUTCOME.CANCELLED],
    ['failed', RUN_OUTCOME.FAILED],
    ['stopped', RUN_OUTCOME.COMPLETED],
    ['error', RUN_OUTCOME.FAILED],
  ] as const)(
    'maps GROUP_END data.status %s to task-group status %s',
    (wireStatus, expectedStatus) => {
      const getState = seedWorkflowStream();

      dispatchLogDelta([
        groupStartEntry('run-0'),
        groupEndEntry('run-0', wireStatus),
      ]);

      const taskGroups = getState().streamStates.get(STREAM_ID)?.taskGroups;
      expect(taskGroups?.[0]?.status).toBe(expectedStatus);
    },
  );

  it('preserves an ambiguous Round N group identically to the shared cold reader', () => {
    const getState = seedWorkflowStream();
    const legacyRound = {
      ...groupEndEntry('legacy-round', 'stopped'),
      text: 'Round 2',
    };

    dispatchLogDelta([legacyRound]);

    const extensionTaskGroups =
      getState().streamStates.get(STREAM_ID)?.taskGroups;
    expect(extensionTaskGroups).toEqual(
      projectTaskGroupsFromStreamLog([legacyRound]),
    );
    expect(extensionTaskGroups).toMatchObject([
      {
        id: 'legacy-round',
        name: 'Round 2',
        status: RUN_OUTCOME.COMPLETED,
      },
    ]);
    expect(extensionTaskGroups?.[0]?.kind).toBeUndefined();
    expect(extensionTaskGroups?.[0]?.index).toBeUndefined();
  });
});
