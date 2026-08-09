import { beforeEach, describe, expect, it } from 'vitest';

import { isStreamingTextLogMessage } from '@progressView/frontend/formatters/baseLogFormatter';
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
  createStreamState,
  type ProgressViewOutboundHandlerRegistry,
  type ProgressViewOutboundMessage,
  type StreamLogEntry,
  type StreamLogTextDelta,
  type StreamTabId,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { projectTaskGroupsFromStreamLog } from '@shared/streams/taskGroupProjection';
import { assertSupported } from '@shared/utils/dispatcher';

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
  const handler = handlers[message.command];
  expect(handler).toBeDefined();
  assertSupported(handler!)(message as never);
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

    expect(getState().streamLogs.get(STREAM_ID)?.logs[0]?.text).toBe('hello');
  });

  it('appends streamed text without whole-entry replacement and finalizes via full update', () => {
    const getState = seedWorkflowStream();

    dispatchLogDelta([modelResponseEntry('hello', 'running')]);

    dispatchLogDelta([], {
      textDeltas: [{ id: 'model-response', appendText: ' world' }],
    });

    const streamedLogs = getState().streamLogs.get(STREAM_ID);
    const streamed = streamedLogs?.logs[0];
    expect(streamed?.text).toBe('hello world');
    expect(streamedLogs?.updatedMessageIndices).toEqual([0]);
    expect(streamed && isStreamingTextLogMessage(streamed)).toBe(true);

    dispatchLogDelta([], {
      updates: [modelResponseEntry('hello world', 'completed')],
    });

    const finalizedLogs = getState().streamLogs.get(STREAM_ID);
    const finalized = finalizedLogs?.logs[0];
    expect(finalized?.text).toBe('hello world');
    expect(finalizedLogs?.updatedMessageIndices).toEqual([0]);
    expect(finalized && isStreamingTextLogMessage(finalized)).toBe(false);
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
    expect(getState().streamLogs.get(STREAM_ID)?.logs).toEqual([
      expect.objectContaining({
        id: 'compaction:operation-1',
        data: expect.objectContaining({ status: 'running' }),
      }),
    ]);

    dispatchLogDelta([activityEntry(2, 'completed')]);
    const streamLogs = getState().streamLogs.get(STREAM_ID);
    expect(streamLogs?.logs).toHaveLength(1);
    expect(streamLogs?.logs[0]).toMatchObject({
      id: 'compaction:operation-1',
      data: { status: 'completed', operationId: 'operation-1' },
    });
    expect(streamLogs?.updatedMessageIndices).toEqual([0]);
  });

  it('keeps valid group-start fields when status is unrecognized', () => {
    const getState = seedWorkflowStream();

    dispatchLogDelta([
      {
        seqNo: 1,
        id: 'group-1',
        type: STREAM_LOG_ENTRY_TYPES.GROUP_START,
        level: LOG_LEVELS.INFO,
        timestamp: 100,
        text: 'Round 1',
        data: { status: 'bogus', kind: 'round', index: 1, total: 3 },
      },
    ]);

    const group = getState().streamStates.get(STREAM_ID)?.taskGroups[0];
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

describe('LOG_DELTA active skill snapshots', () => {
  beforeEach(() => {
    resetProgressState();
  });

  function activeSkillsEntry(seqNo: number, data: unknown): StreamLogEntry {
    return {
      seqNo,
      settlementSeqNo: seqNo,
      id: `skills-${seqNo}`,
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: seqNo,
      messageType: MESSAGE_TYPES.ACTIVE_SKILLS,
      data,
    };
  }

  it('replays the latest stream-scoped snapshot and hides its metadata rows', () => {
    const state = createInitialState();
    state.streamStates.set(STREAM_ID, createStreamState(AgentCategory.ToolUse));
    appState.set(state);

    dispatchLogDelta([
      activeSkillsEntry(1, {
        skills: [
          {
            name: 'first',
            description: 'First skill.',
            source: 'bundled',
          },
        ],
      }),
      activeSkillsEntry(2, { skills: [] }),
    ]);

    const current = appState.get();
    expect(current.streamStates.get(STREAM_ID)).toMatchObject({
      activeSkills: [],
    });
    expect(current.streamLogs.get(STREAM_ID)?.logs).toEqual([]);
  });

  it('sanitizes adversarial persisted summaries during replay', () => {
    const state = createInitialState();
    state.streamStates.set(STREAM_ID, createStreamState(AgentCategory.ToolUse));
    appState.set(state);

    dispatchLogDelta([
      activeSkillsEntry(1, {
        skills: [
          {
            name: 'safe-replay',
            description:
              '\u001b[31mReview\u001b[0m /Users/Jane Doe/private notes.txt before ../release/key.pem.',
            source: 'project',
          },
        ],
      }),
    ]);

    expect(appState.get().streamStates.get(STREAM_ID)).toMatchObject({
      activeSkills: [
        {
          name: 'safe-replay',
          description: 'Details available on activation.',
          source: 'project',
        },
      ],
    });
  });

  it('clears malformed latest data and never projects it onto workflow streams', () => {
    const toolState = createInitialState();
    toolState.streamStates.set(
      STREAM_ID,
      createStreamState(AgentCategory.ToolUse, {
        activeSkills: [
          {
            name: 'stale',
            description: 'Stale skill.',
            source: 'user',
          },
        ],
      }),
    );
    appState.set(toolState);
    dispatchLogDelta([activeSkillsEntry(1, { skills: [{ path: '/secret' }] })]);
    expect(appState.get().streamStates.get(STREAM_ID)).toMatchObject({
      activeSkills: [],
    });

    const workflowState = createInitialState();
    workflowState.streamStates.set(
      STREAM_ID,
      createStreamState(AgentCategory.Workflow),
    );
    appState.set(workflowState);
    dispatchLogDelta([
      activeSkillsEntry(2, {
        skills: [
          {
            name: 'parent-only',
            description: 'Must not inherit.',
            source: 'project',
          },
        ],
      }),
    ]);
    expect(appState.get().streamStates.get(STREAM_ID)).not.toHaveProperty(
      'activeSkills',
    );
  });
});
