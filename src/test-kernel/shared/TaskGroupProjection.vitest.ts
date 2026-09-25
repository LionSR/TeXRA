import { describe, expect, it } from 'vitest';

import {
  RUN_OUTCOME,
  RUN_PHASE,
  type TaskGroup,
  type TranscriptEvent,
} from '@shared/schemas';
import {
  taskGroupDisplayStatus,
  taskGroupOnStage,
} from '@shared/runs/taskGroupProjection';

type StageEvent = Extract<
  TranscriptEvent,
  { readonly type: 'stage.start' | 'stage.end' }
>;

/** Replay stage events at their clocks the way the session fold does: each
 *  writes over the group it names. */
function project(
  events: readonly (readonly [StageEvent, number])[],
  attemptId?: string,
): TaskGroup[] {
  const groups: TaskGroup[] = [];
  for (const [event, at] of events) {
    const index = groups.findIndex((group) => group.id === event.id);
    const group = taskGroupOnStage(groups[index], event, at, attemptId);
    if (!group) continue;
    if (index === -1) groups.push(group);
    else groups[index] = group;
  }
  return groups;
}

describe('task-group projection from stage events', () => {
  it('projects group metadata and completes groups in source order', () => {
    const taskGroups = project([
      [
        {
          type: 'stage.start',
          id: 'run-1',
          label: 'Run: auditor',
          kind: 'run',
        },
        100,
      ],
      [
        {
          type: 'stage.start',
          id: 'round-1',
          label: 'Round 1',
          parentId: 'run-1',
          kind: 'round',
          index: 1,
          total: 2,
        },
        100,
      ],
      [
        { type: 'stage.end', id: 'round-1', status: RUN_OUTCOME.COMPLETED },
        180,
      ],
    ]);

    expect(taskGroups).toEqual([
      {
        id: 'run-1',
        name: 'Run: auditor',
        startTime: 100,
        status: RUN_PHASE.RUNNING,
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

  it('tags a workflow phase with the declared attempt and writes nothing for an unopened end', () => {
    expect(
      project(
        [
          [{ type: 'stage.start', id: 'p', label: 'Map', kind: 'phase' }, 1],
          [{ type: 'stage.start', id: 'r', label: 'r0', kind: 'round' }, 2],
          [{ type: 'stage.end', id: 'never', status: RUN_OUTCOME.FAILED }, 3],
        ],
        'attempt-2',
      ),
    ).toStrictEqual([
      {
        id: 'p',
        name: 'Map',
        startTime: 1,
        status: RUN_PHASE.RUNNING,
        kind: 'phase',
        attemptId: 'attempt-2',
      },
      {
        id: 'r',
        name: 'r0',
        startTime: 2,
        status: RUN_PHASE.RUNNING,
        kind: 'round',
      },
    ]);
  });

  it("paints a group the run never closed as the run's own durable outcome", () => {
    const [group] = project([
      [
        {
          type: 'stage.start',
          id: 'run-1',
          label: 'Run: auditor',
          kind: 'run',
        },
        100,
      ],
    ]);

    // A run nothing can still settle: no producer is left to write GROUP_END,
    // so the group paints as the outcome the exit drain would have written.
    expect(taskGroupDisplayStatus(group!, RUN_OUTCOME.CANCELLED)).toBe(
      RUN_PHASE.CANCELLED,
    );
    expect(taskGroupDisplayStatus(group!, RUN_OUTCOME.COMPLETED)).toBe(
      RUN_PHASE.COMPLETED,
    );
    // Anything else — still running, unwinding from a stop, owned by another
    // process — leaves the transcript's own status standing.
    expect(taskGroupDisplayStatus(group!, undefined)).toBe(RUN_PHASE.RUNNING);
  });
});
