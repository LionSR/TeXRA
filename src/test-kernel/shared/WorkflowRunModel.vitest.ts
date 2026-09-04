// The one workflow-run model both hosts render. These tests pin the folds the
// hosts must never redo: phase order, attempt scoping, the declared-plan
// union, which card may open which child stream, and the attention-first row
// order of a phase.

import { describe, expect, it } from 'vitest';

import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  type StreamLifecycleStatus,
  type StreamLogEntry,
  type StreamTabId,
  type TaskGroup,
  type WorkflowCallProgress,
  type WorkflowPlanMarker,
} from '@shared/schemas';
import type { WorkflowTaskRow } from '@shared/transcript';
import {
  formatWorkflowCallLiveParts,
  workflowMarkerOf,
  workflowPhaseRows,
  workflowRunModel,
  type ChildRunProgress,
  type WorkflowRunModel,
} from '@shared/streams/workflowRunModel';

interface TaskSpec {
  readonly id: string;
  readonly phase?: string;
  readonly childStreamId?: StreamTabId;
  readonly status?: WorkflowCallProgress['status'];
  readonly attemptId?: string;
}

function phaseGroup(name: string, index: number, total: number): TaskGroup {
  return {
    id: `phase-${name}`,
    name,
    startTime: 0,
    status: 'running',
    kind: 'phase',
    index,
    total,
  };
}

function taskRow(task: TaskSpec): WorkflowTaskRow {
  const identity = {
    id: task.id,
    label: task.id,
    ...(task.phase === undefined ? {} : { phase: task.phase }),
    ...(task.childStreamId === undefined
      ? {}
      : { childStreamId: task.childStreamId }),
    ...(task.attemptId === undefined ? {} : { attemptId: task.attemptId }),
  };
  const status = task.status ?? 'running';
  let call: WorkflowCallProgress;
  if (status === 'failed') call = { ...identity, status, error: 'boom' };
  else if (status === 'skipped') call = { ...identity, status, reason: 'user' };
  else call = { ...identity, status } as WorkflowCallProgress;
  return {
    kind: 'workflowTask',
    id: `task-${task.id}`,
    timestamp: 0,
    level: 'info',
    ...(task.phase === undefined ? {} : { groupId: `phase-${task.phase}` }),
    call,
    line: `${status}: ${task.id}`,
    statusLabel: status,
    metadataParts: [],
  };
}

function modelOf(
  phases: readonly string[],
  tasks: readonly TaskSpec[],
  options: {
    plan?: WorkflowPlanMarker;
    streamPhase?: StreamLifecycleStatus;
    runDurablyFinal?: boolean;
    childProgress?: ReadonlyMap<StreamTabId, ChildRunProgress>;
  } = {},
): WorkflowRunModel {
  return workflowRunModel({
    taskGroups: phases.map((name, index) =>
      phaseGroup(name, index, phases.length),
    ),
    rows: tasks.map((task) =>
      taskRow(
        task.attemptId === undefined && options.plan
          ? { ...task, attemptId: options.plan.attemptId }
          : task,
      ),
    ),
    plan: options.plan,
    streamPhase: options.streamPhase,
    runDurablyFinal: options.runDurablyFinal === true,
    childProgress: options.childProgress ?? new Map(),
  });
}

describe('workflow run model', () => {
  it('orders phases by first appearance and cards by transcript order', () => {
    const model = modelOf(
      ['Map', 'Reduce'],
      [
        { id: 'inspect', phase: 'Map', childStreamId: 'c1' as StreamTabId },
        { id: 'extract', phase: 'Map' },
        { id: 'merge', phase: 'Reduce' },
        { id: 'report', phase: 'Reduce' },
      ],
    );
    expect(model.phases.map((phase) => phase.key)).toStrictEqual([
      'phase-Map',
      'phase-Reduce',
    ]);
    expect(model.tasks.map((row) => row.call.label)).toStrictEqual([
      'inspect',
      'extract',
      'merge',
      'report',
    ]);
    expect(model.phases[0]?.cells).toStrictEqual(['running', 'running']);
    expect(model.tally).toStrictEqual({
      done: 0,
      total: 4,
      running: 4,
      failed: 0,
      declared: 0,
    });
  });

  it('scopes resumed calls and phase boundaries to the newest attempt', () => {
    const oldMap = {
      ...phaseGroup('Map', 0, 2),
      id: 'old-map',
    };
    const oldEmpty = {
      ...phaseGroup('Review', 1, 2),
      id: 'old-review',
      attemptId: 'a1',
    };
    const newMap = {
      ...phaseGroup('Map', 0, 2),
      id: 'new-map',
    };
    const newEmpty = {
      ...phaseGroup('Review', 1, 2),
      id: 'new-review',
      attemptId: 'a2',
    };
    const old = {
      ...taskRow({
        id: 'old-failure',
        phase: 'Map',
        status: 'failed',
        attemptId: 'a1',
      }),
      groupId: oldMap.id,
      seqNo: 10,
    };
    const resumedPhase = {
      ...taskRow({
        id: 'resumed-phase',
        phase: 'Map',
        status: 'completed',
        attemptId: 'a2',
      }),
      groupId: newMap.id,
      seqNo: 30,
    };
    const resumedUngrouped = {
      ...taskRow({ id: 'resumed-unphased', attemptId: 'a2' }),
      seqNo: 40,
    };

    const model = workflowRunModel({
      taskGroups: [oldMap, oldEmpty, newMap, newEmpty],
      // A tree renderer can present root rows before child rows. seqNo remains
      // the transcript authority regardless of that input arrangement.
      rows: [resumedUngrouped, resumedPhase, old],
      plan: { kind: 'workflowPlan', attemptId: 'a2', phases: [], tasks: [] },
      streamPhase: undefined,
      runDurablyFinal: false,
      childProgress: new Map(),
    });

    expect(model.tasks.map((row) => row.call.id)).toStrictEqual([
      'resumed-phase',
      'resumed-unphased',
    ]);
    expect(model.phases.map((phase) => phase.key)).toStrictEqual([
      newMap.id,
      newEmpty.id,
      `unphased-${resumedUngrouped.id}`,
    ]);
    expect(model.tally).toStrictEqual({
      done: 1,
      total: 2,
      running: 1,
      failed: 0,
      declared: 0,
    });
  });

  it("settles an interrupted run's cards in the producer's vocabulary", () => {
    // The write side (`StreamLogStore.endRunningGroupsForStreams`) rewrites a
    // launched call as `failed` and an unlaunched one as `skipped`/
    // `not-reached`. The read-side repaint must say the same thing, or the
    // same run reads differently before and after its transcript is settled.
    const model = modelOf(
      ['Map'],
      [
        { id: 'launched', phase: 'Map', status: 'running' },
        { id: 'never-reached', phase: 'Map', status: 'queued' },
        { id: 'done', phase: 'Map', status: 'completed' },
      ],
      { runDurablyFinal: true },
    );

    expect(model.tasks.map((row) => row.call)).toMatchObject([
      {
        id: 'launched',
        status: 'failed',
        error: 'The previous host stopped before this call completed.',
      },
      { id: 'never-reached', status: 'skipped', reason: 'not-reached' },
      { id: 'done', status: 'completed' },
    ]);
    // The card's explanatory line is repainted too: the progress view reads it
    // off the row, not off the call, so dropping it would leave the repainted
    // card silent where the settled one explains itself.
    expect(model.tasks.map((row) => row.detail)).toStrictEqual([
      {
        kind: 'error',
        text: 'The previous host stopped before this call completed.',
      },
      {
        kind: 'note',
        text: 'The workflow ended before this call was reached.',
      },
      undefined,
    ]);
    expect(model.tally).toMatchObject({ done: 3, total: 3, running: 0 });
  });

  it('uses a new plan boundary before its calls or tagged phases arrive', () => {
    const stale = {
      ...phaseGroup('Old', 0, 2),
      id: 'old-empty',
      attemptId: 'a1',
    };
    const current = {
      ...phaseGroup('Current', 1, 2),
      id: 'current-empty',
    };
    const staleUntaggedCard = {
      ...taskRow({ id: 'old-call', phase: 'Old', status: 'failed' }),
      groupId: stale.id,
    };

    const model = workflowRunModel({
      taskGroups: [stale, current],
      rows: [staleUntaggedCard],
      plan: { kind: 'workflowPlan', attemptId: 'a2', phases: [], tasks: [] },
      streamPhase: undefined,
      runDurablyFinal: false,
      childProgress: new Map(),
    });

    expect(model.tasks).toStrictEqual([]);
    // Explicit old ownership is actionable. Missing ownership is not: mixed-
    // version traces cannot distinguish an old call-less phase from this
    // genuinely current one, so the compatible choice is to preserve it.
    expect(model.phases.map((phase) => phase.key)).toStrictEqual([current.id]);
  });

  it('deduplicates an untagged empty phase when the latest attempt owns its identity', () => {
    const oldMap = {
      ...phaseGroup('Map', 0, 1),
      id: 'old-map',
    };
    const currentMap = {
      ...phaseGroup('Map', 0, 1),
      id: 'current-map',
      attemptId: 'a2',
    };

    const model = workflowRunModel({
      taskGroups: [oldMap, currentMap],
      rows: [],
      plan: { kind: 'workflowPlan', attemptId: 'a2', phases: [], tasks: [] },
      streamPhase: undefined,
      runDurablyFinal: false,
      childProgress: new Map(),
    });

    expect(model.phases.map((phase) => phase.key)).toStrictEqual([
      currentMap.id,
    ]);
  });

  it('uses a call-less tagged phase as the latest fallback boundary', () => {
    const oldMap = {
      ...phaseGroup('Map', 0, 2),
      id: 'old-map',
      startTime: 10,
      attemptId: 'a1',
    };
    const currentReview = {
      ...phaseGroup('Review', 1, 2),
      id: 'current-review',
      startTime: 30,
      attemptId: 'a2',
    };
    const oldCard = {
      ...taskRow({ id: 'old-card', phase: 'Map', attemptId: 'a1' }),
      groupId: oldMap.id,
      seqNo: 10,
      timestamp: 20,
    };

    const model = workflowRunModel({
      taskGroups: [oldMap, currentReview],
      rows: [oldCard],
      plan: undefined,
      streamPhase: undefined,
      runDurablyFinal: false,
      childProgress: new Map(),
    });

    expect(model.tasks).toStrictEqual([]);
    expect(model.phases.map((phase) => phase.key)).toStrictEqual([
      currentReview.id,
    ]);
  });

  it('orders mixed-generation cards by the shared transcript fallback', () => {
    const oldChild = {
      ...taskRow({ id: 'old-child', phase: 'Map', attemptId: 'a1' }),
      seqNo: 10,
      timestamp: 10,
    };
    const resumedRoot = {
      ...taskRow({ id: 'resumed-root', attemptId: 'a2' }),
      timestamp: 20,
    };

    const model = workflowRunModel({
      taskGroups: [],
      // Tree pre-order places the newer root row before the older grouped
      // child. Mixed-generation rows fall back to timestamps, not input order.
      rows: [resumedRoot, oldChild],
      plan: undefined,
      streamPhase: undefined,
      runDurablyFinal: false,
      childProgress: new Map(),
    });

    expect(model.tasks.map((row) => row.call.id)).toStrictEqual([
      'resumed-root',
    ]);
  });

  it('selects an attempt deterministically across clock-skewed row generations', () => {
    const oldChild = {
      ...taskRow({ id: 'old-child', phase: 'Map', attemptId: 'a1' }),
      seqNo: 10,
      timestamp: 300,
    };
    const currentChild = {
      ...taskRow({ id: 'current-child', phase: 'Map', attemptId: 'a2' }),
      seqNo: 20,
      timestamp: 100,
    };
    const currentLegacyRoot = {
      ...taskRow({ id: 'current-legacy-root', attemptId: 'a2' }),
      timestamp: 200,
    };

    const model = workflowRunModel({
      taskGroups: [],
      // Root-first input plus 300 > 200 > 100 creates a cycle for pairwise
      // seqNo/timestamp sorting. Attempt selection must not depend on that sort.
      rows: [currentLegacyRoot, currentChild, oldChild],
      plan: undefined,
      streamPhase: undefined,
      runDurablyFinal: false,
      childProgress: new Map(),
    });

    expect(model.tasks.map((row) => row.call.id)).toStrictEqual([
      'current-child',
      'current-legacy-root',
    ]);
  });

  it('leads a phase with what needs attention and collapses the rest into counted groups', () => {
    const model = modelOf(
      ['Derive'],
      [
        { id: 'q1', phase: 'Derive', status: 'queued' },
        { id: 'ok1', phase: 'Derive', status: 'completed' },
        { id: 'r1', phase: 'Derive', status: 'running' },
        { id: 'bad', phase: 'Derive', status: 'failed' },
        { id: 'q2', phase: 'Derive', status: 'planned' },
        { id: 'r2', phase: 'Derive', status: 'running' },
        { id: 'ok2', phase: 'Derive', status: 'cached' },
      ],
      {
        plan: {
          kind: 'workflowPlan',
          attemptId: 'attempt-1',
          phases: [{ title: 'Derive' }],
          tasks: [{ id: 'later', label: 'Later on', phase: 'Derive' }],
        },
      },
    );
    const phase = model.phases[0]!;
    const summarize = (rows: ReturnType<typeof workflowPhaseRows>) =>
      rows.map((row) =>
        row.kind === 'group'
          ? `${row.expanded ? '▾' : '▸'} ${row.count} ${row.group}`
          : row.key,
      );

    // Failed, then running — transcript order within each — then the finished
    // cards as rows, and one row per unstarted group.
    expect(
      summarize(workflowPhaseRows(phase, { expanded: new Set(), filter: '' })),
    ).toStrictEqual([
      'task:task-bad',
      'task:task-r1',
      'task:task-r2',
      'task:task-ok1',
      'task:task-ok2',
      '▸ 2 queued',
      '▸ 1 declared',
    ]);
    // An opened group lists its members under its header, in place.
    expect(
      summarize(
        workflowPhaseRows(phase, { expanded: new Set(['queued']), filter: '' }),
      ),
    ).toStrictEqual([
      'task:task-bad',
      'task:task-r1',
      'task:task-r2',
      'task:task-ok1',
      'task:task-ok2',
      '▾ 2 queued',
      'task:task-q1',
      'task:task-q2',
      '▸ 1 declared',
    ]);
    // A filter is one flat list of matches, groups and all.
    expect(
      summarize(
        workflowPhaseRows(phase, { expanded: new Set(), filter: 'ok' }),
      ),
    ).toStrictEqual(['task:task-ok1', 'task:task-ok2']);
    expect(
      summarize(
        workflowPhaseRows(phase, { expanded: new Set(), filter: 'later' }),
      ),
    ).toStrictEqual(['declared:later']);
    expect(phase.tally).toStrictEqual({
      done: 3,
      total: 7,
      running: 2,
      failed: 1,
      declared: 1,
    });
  });

  it('lists declared phases and tasks the run has not reached, never a card twice', () => {
    const plan: WorkflowPlanMarker = {
      kind: 'workflowPlan',
      attemptId: 'attempt-1',
      phases: [{ title: 'Map' }, { title: 'Reduce' }, { title: 'Publish' }],
      tasks: [
        { id: 'inspect', label: 'inspect', phase: 'Map' },
        { id: 'extract', label: 'Extract facts', phase: 'Map' },
        { id: 'merge', label: 'Merge results', phase: 'Reduce' },
      ],
    };
    const tasks = [{ id: 'inspect', phase: 'Map' }];
    const summarize = (model: WorkflowRunModel) =>
      model.phases.map((phase) => [
        phase.heading.phaseLabel,
        phase.opened,
        phase.tasks.length,
        phase.declaredTasks.map((task) => task.id),
      ]);

    const live = modelOf(['Map'], tasks, { plan });
    expect(summarize(live)).toEqual([
      ['Map', true, 1, ['extract']],
      ['Reduce', false, 0, ['merge']],
      ['Publish', false, 0, []],
    ]);
    expect(live.phases[1]?.heading).toEqual({
      phaseLabel: 'Reduce',
      phaseIndex: 1,
      phaseTotal: 3,
    });
    // Once the run has settled, a plan-only phase it never reached and that
    // holds no declared task is gone; one still holding declared tasks stays.
    expect(
      summarize(
        modelOf(['Map'], tasks, { plan, streamPhase: STREAM_PHASE.COMPLETED }),
      ),
    ).toEqual([
      ['Map', true, 1, ['extract']],
      ['Reduce', false, 0, ['merge']],
    ]);
  });

  it('gives an ambiguous child stream to no card at all', () => {
    const shared = 'shared-child' as StreamTabId;
    const own = 'own-child' as StreamTabId;
    const live: ChildRunProgress = {
      runStartedAt: 1_000,
      toolCallCount: 7,
      outputTokens: 12_000,
      costUsd: 0.03,
    };
    const model = modelOf(
      [],
      [
        { id: 'first', childStreamId: shared },
        { id: 'second', childStreamId: shared },
        { id: 'third', childStreamId: own },
      ],
      {
        childProgress: new Map([
          [shared, live],
          [own, live],
        ]),
      },
    );
    expect(
      model.tasks.map((row) => model.childStreamOf.get(row.id)),
    ).toStrictEqual([undefined, undefined, 'own-child']);
    // The live join follows the same claimant rule, and its copy is one
    // string per fact — elapsed only with a clock, tokens and tools always.
    expect(model.tasks.map((row) => model.liveOf.get(row.id))).toStrictEqual([
      undefined,
      undefined,
      live,
    ]);
    const third = model.tasks[2]!;
    expect(formatWorkflowCallLiveParts(third.call, live, 13_000)).toStrictEqual(
      ['12s', '↓12k', '$0.030', '7 tools'],
    );
    expect(formatWorkflowCallLiveParts(third.call, live)).toStrictEqual([
      '↓12k',
      '$0.030',
      '7 tools',
    ]);
    // Cards outside any phase share one trailing heading.
    expect(model.phases.map((phase) => phase.heading.phaseLabel)).toStrictEqual(
      ['Unphased'],
    );
  });

  it('reads a phase heading from its task group, closed or open', () => {
    const model = modelOf(['Verify'], [{ id: 'v', phase: 'Verify' }]);
    expect(model.phases[0]?.heading).toStrictEqual({
      phaseLabel: 'Verify',
      phaseIndex: 0,
      phaseTotal: 1,
    });
    const closed: TaskGroup = {
      ...phaseGroup('Verify', 0, 1),
      status: 'completed',
      endTime: 5,
    };
    expect(
      workflowRunModel({
        taskGroups: [closed],
        rows: [taskRow({ id: 'v', phase: 'Verify' })],
        plan: undefined,
        streamPhase: STREAM_PHASE.COMPLETED,
        runDurablyFinal: false,
        childProgress: new Map(),
      }).phases[0]?.heading,
    ).toStrictEqual({ phaseLabel: 'Verify', phaseIndex: 0, phaseTotal: 1 });
  });

  it('reads the attempt and plan markers off INTERNAL entries', () => {
    const entry = (data: unknown): StreamLogEntry =>
      ({
        id: 'm',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: 'info',
        timestamp: 0,
        messageType: MESSAGE_TYPES.INTERNAL,
        data,
        verbose: false,
      }) as StreamLogEntry;
    const plan = {
      kind: 'workflowPlan',
      attemptId: 'a',
      phases: [{ title: 'Map' }],
      tasks: [],
    };
    expect(workflowMarkerOf(entry(plan))).toStrictEqual({
      kind: 'plan',
      attemptId: 'a',
      plan,
    });
    expect(
      workflowMarkerOf(
        entry({ kind: 'workflowPlan', attemptId: 'new', phases: 'broken' }),
      ),
    ).toMatchObject({ kind: 'malformedPlan', attemptId: 'new' });
    expect(workflowMarkerOf(entry({ kind: 'somethingElse' }))).toBeUndefined();
  });
});
