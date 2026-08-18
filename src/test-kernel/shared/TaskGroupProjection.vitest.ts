import { describe, expect, it } from 'vitest';

import {
  LOG_LEVELS,
  RUN_OUTCOME,
  STREAM_LOG_ENTRY_TYPES,
  StreamLogEntrySchema,
  STREAM_PHASE,
  type StreamLogEntry,
  type TaskGroup,
} from '@shared/schemas';
import { upsertTaskGroupFromStreamLog } from '@shared/streams/taskGroupProjection';

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

interface GroupEntryOverrides {
  readonly groupId?: string;
  readonly text?: string;
  readonly data?: unknown;
}

function entry(
  id: string,
  type:
    | typeof STREAM_LOG_ENTRY_TYPES.GROUP_START
    | typeof STREAM_LOG_ENTRY_TYPES.GROUP_END,
  overrides: GroupEntryOverrides = {},
): StreamLogEntry {
  return StreamLogEntrySchema.parse({
    seqNo: type === STREAM_LOG_ENTRY_TYPES.GROUP_START ? 1 : 2,
    id,
    type,
    level: LOG_LEVELS.INFO,
    timestamp: type === STREAM_LOG_ENTRY_TYPES.GROUP_START ? 100 : 200,
    ...overrides,
  });
}

describe('task-group StreamLog projection', () => {
  it('projects group metadata and completes groups in source order', () => {
    const taskGroups = projectTaskGroupsFromStreamLog([
      entry('run-1', STREAM_LOG_ENTRY_TYPES.GROUP_START, {
        text: 'Run: auditor',
        data: { status: STREAM_PHASE.RUNNING, kind: 'run' },
      }),
      entry('round-1', STREAM_LOG_ENTRY_TYPES.GROUP_START, {
        groupId: 'run-1',
        text: 'Round 1',
        data: {
          status: STREAM_PHASE.RUNNING,
          kind: 'round',
          index: 1,
          total: 2,
        },
      }),
      entry('round-1', STREAM_LOG_ENTRY_TYPES.GROUP_END, {
        groupId: 'run-1',
        text: 'Round 1',
        data: {
          status: RUN_OUTCOME.COMPLETED,
          kind: 'round',
          endTime: 180,
        },
      }),
    ]);

    expect(taskGroups).toEqual([
      {
        id: 'run-1',
        name: 'Run: auditor',
        startTime: 100,
        status: STREAM_PHASE.RUNNING,
        kind: 'run',
      },
      {
        id: 'round-1',
        name: 'Round 1',
        startTime: 100,
        endTime: 180,
        status: RUN_OUTCOME.COMPLETED,
        parentGroupId: 'run-1',
        kind: 'round',
        index: 1,
        total: 2,
      },
    ]);
  });

  it.each([
    ['stopped', RUN_OUTCOME.COMPLETED],
    ['error', RUN_OUTCOME.FAILED],
  ] as const)('normalizes legacy end status %s', (status, expected) => {
    const [taskGroup] = projectTaskGroupsFromStreamLog([
      entry('run-1', STREAM_LOG_ENTRY_TYPES.GROUP_END, {
        text: 'Run: auditor',
        data: { status, endTime: 200 },
      }),
    ]);

    expect(taskGroup).toEqual({
      id: 'run-1',
      name: 'Run: auditor',
      startTime: 200,
      endTime: 200,
      status: expected,
    });
  });

  it('repairs a stale index before incrementally updating an existing group', () => {
    const taskGroups = projectTaskGroupsFromStreamLog([
      entry('run-1', STREAM_LOG_ENTRY_TYPES.GROUP_START, {
        text: 'Run: auditor',
        data: {},
      }),
    ]);
    const staleIndex = new Map([['run-1', 4]]);

    expect(
      upsertTaskGroupFromStreamLog(
        taskGroups,
        staleIndex,
        entry('run-1', STREAM_LOG_ENTRY_TYPES.GROUP_END, {
          data: { status: RUN_OUTCOME.FAILED, endTime: 250 },
        }),
      ),
    ).toBe(true);
    expect(staleIndex.get('run-1')).toBe(0);
    expect(taskGroups).toHaveLength(1);
    expect(taskGroups[0]?.status).toBe(RUN_OUTCOME.FAILED);
    expect(taskGroups[0]?.endTime).toBe(250);
  });

  it('ignores ordinary log rows', () => {
    const taskGroups = projectTaskGroupsFromStreamLog([
      {
        seqNo: 1,
        id: 'message-1',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 100,
        text: 'ordinary message',
      },
    ]);

    expect(taskGroups).toEqual([]);
  });
});
