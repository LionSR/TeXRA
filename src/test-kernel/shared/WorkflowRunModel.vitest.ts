// The one workflow-run model both hosts render. These tests pin the folds the
// hosts must never redo: phase order, attempt scoping, the declared-plan
// union, which card may open which child stream, and the attention-first row
// order of a phase.

import { describe, expect, it } from 'vitest';

import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
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
    runSettled?: boolean;
    childProgress?: ReadonlyMap<StreamTabId, ChildRunProgress>;
  } = {},
): WorkflowRunModel {
  return workflowRunModel({
    taskGroups: phases.map((name, index) =>
      phaseGroup(name, index, phases.length),
    ),
    rows: tasks.map(taskRow),
    plan: options.plan,
    runSettled: options.runSettled ?? false,
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

  it('scopes cards and phases to the newest attempt', () => {
    const model = modelOf(
      ['Map'],
      [
        { id: 'old', phase: 'Map', status: 'failed', attemptId: 'a1' },
        { id: 'new', phase: 'Map', attemptId: 'a2' },
      ],
    );
    expect(model.tasks.map((row) => row.call.id)).toStrictEqual(['new']);
    expect(model.phases[0]?.tally.failed).toBe(0);
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
        { id: 'wait', phase: 'Derive', status: 'awaitingApproval' },
        { id: 'r2', phase: 'Derive', status: 'running' },
        { id: 'ok2', phase: 'Derive', status: 'cached' },
      ],
      {
        plan: {
          kind: 'workflowPlan',
          attemptId: 'attempt-1',
          phases: [{ title: 'Derive', index: 0 }],
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

    // Awaiting approval, then failed, then running — transcript order within
    // each — then the finished cards as rows, and one row per unstarted group.
    expect(
      summarize(workflowPhaseRows(phase, { expanded: new Set(), filter: '' })),
    ).toStrictEqual([
      'task:task-wait',
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
      'task:task-wait',
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
      total: 8,
      running: 2,
      failed: 1,
      declared: 1,
    });
  });

  it('lists declared phases and tasks the run has not reached, never a card twice', () => {
    const plan: WorkflowPlanMarker = {
      kind: 'workflowPlan',
      attemptId: 'attempt-1',
      phases: [
        { title: 'Map', index: 0 },
        { title: 'Reduce', index: 1 },
        { title: 'Publish', index: 2 },
      ],
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
      summarize(modelOf(['Map'], tasks, { plan, runSettled: true })),
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
        runSettled: true,
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
    expect(
      workflowMarkerOf(entry({ kind: 'workflowAttempt', attemptId: 'a' })),
    ).toStrictEqual({ kind: 'attempt' });
    const plan = {
      kind: 'workflowPlan',
      attemptId: 'a',
      phases: [{ title: 'Map', index: 0 }],
      tasks: [],
    };
    expect(workflowMarkerOf(entry(plan))).toStrictEqual({ kind: 'plan', plan });
    expect(workflowMarkerOf(entry({ kind: 'workflowPlan' }))?.kind).toBe(
      'malformedPlan',
    );
    expect(workflowMarkerOf(entry({ kind: 'somethingElse' }))).toBeUndefined();
  });
});
