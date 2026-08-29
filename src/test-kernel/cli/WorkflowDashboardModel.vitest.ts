// The workflow dashboard is derived once, by `App` (`state/workflowDashboardModel`),
// and read by two consumers: `App` itself reconciles child-list selection and
// stream focus against `listValues`, and `SubagentList` renders the model
// instance it is handed. If those two ever disagree on which rows exist or in
// what order, the keyboard silently points at a row other than the highlighted
// one. These tests pin the agreement.

import { describe, expect, it, vi } from 'vitest';

import { WorkflowPopup } from '@cli/chat/tui/panes/WorkflowPopup';
import {
  emptySlice,
  type StreamSlice,
  type WorkflowPopupView,
} from '@cli/chat/tui/state/cliState';
import {
  uniqueWorkflowChildStreamId,
  workflowDashboardModel,
  workflowPopupRows,
} from '@cli/chat/tui/state/workflowDashboardModel';
import {
  type StreamTabId,
  type TaskGroup,
  type WorkflowCallProgress,
} from '@shared/schemas';
import type { TranscriptRow, TranscriptRowOf } from '@shared/transcript';
import { loadInk, renderInteractive } from '@test/support/inkTestHarness.ts';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';

const ROOT = 'workflow-root' as StreamTabId;

interface TaskSpec {
  readonly id: string;
  readonly phase?: string;
  readonly childStreamId?: StreamTabId;
  readonly status?: WorkflowCallProgress['status'];
}

/** A phase as the run's own lifecycle rows record it — the container both
 *  hosts group by. */
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

function taskRow(task: TaskSpec): TranscriptRowOf<'workflowTask'> {
  const call: WorkflowCallProgress = {
    id: task.id,
    label: task.id,
    status: task.status ?? 'running',
    ...(task.phase === undefined ? {} : { phase: task.phase }),
    ...(task.childStreamId === undefined
      ? {}
      : { childStreamId: task.childStreamId }),
  };
  return {
    kind: 'workflowTask',
    id: `task-${task.id}`,
    timestamp: 0,
    level: 'info',
    ...(task.phase === undefined ? {} : { groupId: `phase-${task.phase}` }),
    call,
    line: `Running: ${task.id}`,
    statusLabel: 'Running',
    metadataParts: [],
  };
}

function workflowRoot(
  phases: readonly string[],
  tasks: readonly TaskSpec[],
): StreamSlice {
  return {
    ...emptySlice(ROOT),
    taskGroups: phases.map((name, index) =>
      phaseGroup(name, index, phases.length),
    ),
    entries: tasks.map(taskRow),
  };
}

/** Two phases, two tasks each, in the order the transcript emitted them. */
const TWO_PHASE_ROOT = workflowRoot(
  ['Map', 'Reduce'],
  [
    {
      id: 'inspect',
      phase: 'Map',
      childStreamId: 'child-inspect' as StreamTabId,
    },
    { id: 'extract', phase: 'Map' },
    { id: 'merge', phase: 'Reduce' },
    { id: 'report', phase: 'Reduce' },
  ],
);

const STREAMS: ReadonlyMap<StreamTabId, StreamSlice> = new Map([
  [ROOT, TWO_PHASE_ROOT],
  ['child-inspect' as StreamTabId, emptySlice('child-inspect' as StreamTabId)],
]);

describe('workflow dashboard model', () => {
  it('orders phase rows by first appearance and task rows by transcript order', () => {
    const model = workflowDashboardModel(TWO_PHASE_ROOT);

    expect(model.groups.map((group) => group.heading.phaseLabel)).toStrictEqual(
      ['Map', 'Reduce'],
    );
    expect(model.tasks.map((entry) => entry.call.label)).toStrictEqual([
      'inspect',
      'extract',
      'merge',
      'report',
    ]);
    expect(model.groups.map((group) => group.key)).toStrictEqual([
      'phase-Map',
      'phase-Reduce',
    ]);
  });

  it('leads a phase with what needs attention and collapses the rest into counted groups', () => {
    const root: StreamSlice = {
      ...workflowRoot(
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
      ),
      workflowPlan: {
        kind: 'workflowPlan',
        attemptId: 'attempt-1',
        phases: [{ title: 'Derive', index: 0 }],
        tasks: [{ id: 'later', label: 'Later on', phase: 'Derive' }],
      },
    };
    const group = workflowDashboardModel(root).groups[0]!;
    const summarize = (rows: ReturnType<typeof workflowPopupRows>) =>
      rows.map((row) =>
        row.kind === 'group'
          ? `${row.expanded ? '▾' : '▸'} ${row.count} ${row.group}`
          : row.key,
      );

    // Awaiting approval, then failed, then running — transcript order within
    // each — and one row per quiet group.
    expect(
      summarize(workflowPopupRows(group, { expanded: new Set(), filter: '' })),
    ).toStrictEqual([
      'task:task-wait',
      'task:task-bad',
      'task:task-r1',
      'task:task-r2',
      '▸ 2 queued',
      '▸ 2 done',
      '▸ 1 declared',
    ]);
    // An opened group lists its members under its header, in place.
    expect(
      summarize(
        workflowPopupRows(group, { expanded: new Set(['queued']), filter: '' }),
      ),
    ).toStrictEqual([
      'task:task-wait',
      'task:task-bad',
      'task:task-r1',
      'task:task-r2',
      '▾ 2 queued',
      'task:task-q1',
      'task:task-q2',
      '▸ 2 done',
      '▸ 1 declared',
    ]);
    // A filter is one flat list of matches, groups and all.
    expect(
      summarize(
        workflowPopupRows(group, { expanded: new Set(), filter: 'ok' }),
      ),
    ).toStrictEqual(['task:task-ok1', 'task:task-ok2']);
    expect(
      summarize(
        workflowPopupRows(group, { expanded: new Set(), filter: 'later' }),
      ),
    ).toStrictEqual(['declared:later']);
  });

  it('lists declared phases and tasks the run has not reached, never a card twice', () => {
    const root: StreamSlice = {
      ...workflowRoot(['Map'], [{ id: 'inspect', phase: 'Map' }]),
      workflowPlan: {
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
      },
    };
    const model = workflowDashboardModel(root);
    const summarize = (groups: typeof model.groups) =>
      groups.map((group) => [
        group.heading.phaseLabel,
        group.opened,
        group.tasks.length,
        group.declaredTasks.map((task) => task.id),
      ]);

    expect(summarize(model.groups)).toEqual([
      ['Map', true, 1, ['extract']],
      ['Reduce', false, 0, ['merge']],
      ['Publish', false, 0, []],
    ]);
    expect(model.groups[1]?.heading).toEqual({
      phaseLabel: 'Reduce',
      phaseIndex: 1,
      phaseTotal: 3,
    });
    // Once the run has settled, a plan-only phase it never reached and that
    // holds no declared task is gone; one still holding declared tasks stays.
    expect(
      summarize(workflowDashboardModel(root, { runSettled: true }).groups),
    ).toEqual([
      ['Map', true, 1, ['extract']],
      ['Reduce', false, 0, ['merge']],
    ]);
  });

  it('gives an ambiguous child stream to no task at all', () => {
    const shared = 'shared-child' as StreamTabId;
    const root = workflowRoot(
      [],
      [
        { id: 'first', childStreamId: shared },
        { id: 'second', childStreamId: shared },
        { id: 'third', childStreamId: 'own-child' as StreamTabId },
      ],
    );
    const streams = new Map([
      [shared, emptySlice(shared)],
      ['own-child' as StreamTabId, emptySlice('own-child' as StreamTabId)],
    ]);
    const model = workflowDashboardModel(root);

    expect(model.childTaskIndex.get(shared)).toBeNull();
    expect(
      model.tasks.map((entry) =>
        uniqueWorkflowChildStreamId(entry, model.childTaskIndex, streams),
      ),
    ).toStrictEqual([undefined, undefined, 'own-child']);
    // A task whose child stream has not been created yet owns no row target.
    expect(
      uniqueWorkflowChildStreamId(
        model.tasks[2]!,
        model.childTaskIndex,
        new Map(),
      ),
    ).toBeUndefined();
  });

  it('reads a phase heading from its task group, closed or open', () => {
    // The shared task-group projection already carries index/total across a
    // `GROUP_END` upsert, so the dashboard has no counts of its own to inherit.
    const root = workflowRoot(
      ['Verify'],
      [{ id: 'verification', phase: 'Verify' }],
    );
    const closed: TaskGroup = {
      ...root.taskGroups[0]!,
      status: 'completed',
      endTime: 5,
    };

    expect(workflowDashboardModel(root).groups[0]?.heading).toStrictEqual({
      phaseLabel: 'Verify',
      phaseIndex: 0,
      phaseTotal: 1,
    });
    expect(
      workflowDashboardModel({ ...root, taskGroups: [closed] }).groups[0]
        ?.heading,
    ).toStrictEqual({ phaseLabel: 'Verify', phaseIndex: 0, phaseTotal: 1 });
  });

  it('renders a current empty dynamic phase and the popup around it', async () => {
    const root = workflowRoot([], []);
    // A phase the script opened dynamically carries no declared position.
    const currentPhase: TaskGroup = {
      id: 'phase-current',
      name: 'Explore',
      startTime: 0,
      status: 'running',
      kind: 'phase',
    };
    const withPhase = { ...root, taskGroups: [currentPhase] };
    const model = workflowDashboardModel(withPhase);
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0]).toMatchObject({
      key: 'phase-current',
      heading: { phaseLabel: 'Explore' },
      tasks: [],
      opened: true,
    });

    const { ink, React } = await loadInk();
    const view: WorkflowPopupView = {
      phaseIndex: 0,
      selectedKey: undefined,
      expanded: new Set(),
      filter: '',
      filterEditing: false,
    };
    const { instance, stdout } = renderInteractive(
      ink,
      React.createElement(WorkflowPopup, {
        activeSubagentExecutionIds: new Map(),
        availableRows: 20,
        model,
        onClose: vi.fn(),
        onFocusStream: vi.fn(),
        onKillExecution: vi.fn(),
        onOpenTranscript: vi.fn(),
        onViewChange: vi.fn(),
        onWorkflowControl: vi.fn(),
        pendingApprovals: undefined,
        streamId: ROOT,
        streams: new Map([[ROOT, withPhase]]),
        view,
      }),
      { columns: 100 },
    );
    try {
      await waitFor(() => stdout.output.includes('◆ Explore · 0/0'));
      // The panel title counts the run; the tab counts the phase.
      expect(stdout.output).toContain('Workflow · 0/0');
      expect(stdout.output).toContain('No calls in this phase yet');
      expect(stdout.output).toContain('Esc close');
    } finally {
      instance.unmount();
    }
  });

  it('windows a big phase to the row budget with attention rows first', async () => {
    const tasks: TaskSpec[] = [
      { id: 'bad', phase: 'Derive', status: 'failed' },
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `run-${index}`,
        phase: 'Derive',
        status: 'running' as const,
      })),
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `queued-${index}`,
        phase: 'Derive',
        status: 'queued' as const,
      })),
    ];
    const root = workflowRoot(['Derive'], tasks);
    const model = workflowDashboardModel(root);
    const { ink, React } = await loadInk();
    const view: WorkflowPopupView = {
      phaseIndex: 0,
      selectedKey: undefined,
      expanded: new Set(),
      filter: '',
      filterEditing: false,
    };
    const { instance, stdout } = renderInteractive(
      ink,
      React.createElement(WorkflowPopup, {
        activeSubagentExecutionIds: new Map(),
        availableRows: 14,
        model,
        onClose: vi.fn(),
        onFocusStream: vi.fn(),
        onKillExecution: vi.fn(),
        onOpenTranscript: vi.fn(),
        onViewChange: vi.fn(),
        onWorkflowControl: vi.fn(),
        pendingApprovals: undefined,
        streamId: ROOT,
        streams: new Map([[ROOT, root]]),
        view,
      }),
      { columns: 100 },
    );
    try {
      await waitFor(() => stdout.output.includes('bad · Failed'));
      const lines = stdout.output.split('\n');
      const failedLine = lines.findIndex((line) =>
        line.includes('bad · Failed'),
      );
      const firstRunning = lines.findIndex((line) =>
        line.includes('run-0 · Running'),
      );
      expect(failedLine).toBeGreaterThan(-1);
      expect(firstRunning).toBeGreaterThan(failedLine);
      // 13 attention rows cannot all fit; the list says how many are below.
      expect(stdout.output).toMatch(/… \d+ more/);
      expect(stdout.output).toContain('12 running');
      expect(stdout.output).toContain('1 failed');
    } finally {
      instance.unmount();
    }
  });
});
