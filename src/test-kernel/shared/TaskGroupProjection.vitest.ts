import { describe, expect, it } from 'vitest';

import {
  qualifyAggregateId,
  RUN_OUTCOME,
  RUN_PHASE,
  type RunId,
  type SessionEvent,
  type TaskGroup,
  type TranscriptEvent,
} from '@shared/schemas';
import { taskGroupDisplayStatus } from '@shared/runs/taskGroupProjection';
import { applyTranscriptEvent } from '@shared/session/transcriptUpdate';
import {
  emptyTranscript,
  emptyTranscriptIndexes,
} from '@shared/session/transcriptState';

type StageEvent = Extract<
  TranscriptEvent,
  { readonly type: 'stage.start' | 'stage.end' }
>;

const AGGREGATE = qualifyAggregateId('run', 'abc123' as RunId);

/** Replay stage events at their clocks through the transcript reducer, as
 *  the session view does, and read the task groups it builds. */
function project(
  events: readonly (readonly [StageEvent, number])[],
): readonly TaskGroup[] {
  const work = { ix: emptyTranscriptIndexes(), owned: new WeakSet<object>() };
  const ctx = { debug: false, lifecycleToTaskGroups: true };
  let transcript = emptyTranscript();
  for (const [index, [event, at]] of events.entries()) {
    const seq = index + 2;
    transcript = applyTranscriptEvent(
      transcript,
      work,
      {
        ...event,
        aggregateId: AGGREGATE,
        seq,
        commit: seq,
        origin: null,
        at,
      } as SessionEvent,
      ctx,
    );
  }
  return transcript.taskGroups;
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
          kind: 'session',
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
        kind: 'session',
      },
    ]);
  });

  it('writes nothing for an unopened end', () => {
    expect(
      project([
        [{ type: 'stage.start', id: 'p', label: 'Map', kind: 'script' }, 1],
        [{ type: 'stage.start', id: 'r', label: 'r0', kind: 'session' }, 2],
        [{ type: 'stage.end', id: 'never', status: RUN_OUTCOME.FAILED }, 3],
      ]),
    ).toStrictEqual([
      {
        id: 'p',
        name: 'Map',
        startTime: 1,
        status: RUN_PHASE.RUNNING,
        kind: 'script',
      },
      {
        id: 'r',
        name: 'r0',
        startTime: 2,
        status: RUN_PHASE.RUNNING,
        kind: 'session',
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
