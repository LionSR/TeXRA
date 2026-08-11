// The workflow dashboard is derived once, by `App` (`state/workflowDashboardModel`),
// and read by two consumers: `App` itself reconciles child-list selection and
// stream focus against `listValues`, and `SubagentList` renders the model
// instance it is handed. If those two ever disagree on which rows exist or in
// what order, the keyboard silently points at a row other than the highlighted
// one. These tests pin the agreement.

import { describe, expect, it, vi } from 'vitest';

import { SubagentList } from '@cli/chat/tui/panes/SubagentList';
import type { ChildListValue } from '@cli/chat/tui/state/childListSelection';
import { emptySlice, type StreamSlice } from '@cli/chat/tui/state/cliState';
import {
  uniqueWorkflowChildStreamId,
  workflowDashboardModel,
} from '@cli/chat/tui/state/workflowDashboardModel';
import { AgentCategory, type StreamTabId } from '@shared/schemas';
import { loadInk, renderInteractive } from '@test/support/inkTestHarness.ts';
import {
  pollForCondition,
  waitForCondition as waitFor,
} from '@test/support/asyncTestUtils';

const ROOT = 'workflow-root' as StreamTabId;
const WIDE_COLUMNS = 100;
const NARROW_COLUMNS = 99;
const ARROW_DOWN = '\u001b[B';
const ARROW_RIGHT = '\u001b[C';

interface TaskSpec {
  readonly id: string;
  readonly phase?: string;
  readonly childStreamId?: StreamTabId;
}

function workflowRoot(
  phases: readonly string[],
  tasks: readonly TaskSpec[],
): StreamSlice {
  return {
    ...emptySlice(ROOT),
    agent: 'workflow',
    identity: { kind: 'multiAgentWorkflow' as const, workflowName: 'workflow' },
    category: AgentCategory.Workflow,
    entries: [
      ...phases.map((phaseLabel, phaseIndex) => ({
        id: `phase-${phaseLabel}`,
        role: 'phase' as const,
        text: phaseLabel,
        finalized: true,
        phaseLabel,
        phaseIndex,
        phaseTotal: phases.length,
      })),
      ...tasks.map((task) => ({
        id: `task-${task.id}`,
        role: 'workflowTask' as const,
        text: `Running: ${task.id}`,
        finalized: false,
        task: {
          id: task.id,
          label: task.id,
          status: 'running' as const,
          ...(task.phase === undefined ? {} : { phase: task.phase }),
          ...(task.childStreamId === undefined
            ? {}
            : { childStreamId: task.childStreamId }),
        },
      })),
    ],
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

/** Drive the mounted list and collect the row values it highlights. */
async function navigate(
  keys: readonly string[],
  props: Record<string, unknown>,
  columns: number,
): Promise<readonly ChildListValue[]> {
  const { ink, React } = await loadInk();
  const visited: ChildListValue[] = [];
  let selected = props.selectedValue as ChildListValue;

  function Harness() {
    const [value, setValue] = React.useState(selected) as [
      ChildListValue,
      (next: ChildListValue) => void,
    ];
    return React.createElement(SubagentList, {
      ...props,
      onSelectionChange: (next: ChildListValue) => {
        visited.push(next);
        selected = next;
        setValue(next);
      },
      selectedValue: value,
    });
  }

  const { instance, stdin } = renderInteractive(
    ink,
    React.createElement(Harness),
    { columns },
  );
  try {
    await waitFor(() => stdin.listenerCount('readable') > 0);
    for (const key of keys) {
      const movesBefore = visited.length;
      stdin.write(key);
      // A press either moves (onSelectionChange fires synchronously once Ink
      // dispatches the key) or deliberately clamps, in which case no move ever
      // comes — so wait for the move event and treat a bounded quiet window as
      // a clamp rather than sleeping a fixed wall-clock delay per key.
      await pollForCondition(() => visited.length > movesBefore, {
        timeoutMs: 250,
        intervalMs: 5,
      });
    }
    return visited;
  } finally {
    instance.unmount();
  }
}

/** Drive the two-phase list with the shared props every test uses. */
function navigateList(
  keys: readonly string[],
  selectedValue: ChildListValue,
  columns: number,
): Promise<readonly ChildListValue[]> {
  return navigate(
    keys,
    {
      keyboardActive: true,
      listRootStreamId: ROOT,
      dashboard: workflowDashboardModel(TWO_PHASE_ROOT, columns),
      maxRows: 12,
      onCancel: vi.fn(),
      selectedValue,
      sessions: [],
      streams: STREAMS,
    },
    columns,
  );
}

describe('workflow dashboard model', () => {
  it('orders phase rows by first appearance and task rows by transcript order', () => {
    const model = workflowDashboardModel(TWO_PHASE_ROOT, WIDE_COLUMNS);

    expect(model.groups.map((group) => group.label)).toStrictEqual([
      'Map',
      'Reduce',
    ]);
    expect(model.tasks.map((entry) => entry.task.label)).toStrictEqual([
      'inspect',
      'extract',
      'merge',
      'report',
    ]);
    // Phase rows only exist in the two-column layout; the narrow list renders
    // them as disabled separators, so they are not reconcilable row values.
    expect(model.listValues).toStrictEqual([
      ...model.groups.map((group) => group.value),
      ...model.tasks.map((entry) => `workflowTask:${entry.id}`),
    ]);
    expect(
      workflowDashboardModel(TWO_PHASE_ROOT, NARROW_COLUMNS).listValues,
    ).toStrictEqual(model.tasks.map((entry) => `workflowTask:${entry.id}`));
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
    const model = workflowDashboardModel(root, WIDE_COLUMNS);

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

  it('renders exactly the narrow row values the reducer reconciles against', async () => {
    const model = workflowDashboardModel(TWO_PHASE_ROOT, NARROW_COLUMNS);
    const visited = await navigateList(
      [ARROW_DOWN, ARROW_DOWN, ARROW_DOWN],
      model.listValues[0]!,
      NARROW_COLUMNS,
    );

    // Arrow navigation skips the disabled phase separators, so the rows the
    // keyboard can reach are exactly `listValues`, in order.
    expect(visited).toStrictEqual(model.listValues.slice(1));
  });

  it('renders exactly the wide phase row values the reducer reconciles against', async () => {
    const model = workflowDashboardModel(TWO_PHASE_ROOT, WIDE_COLUMNS);
    const phaseValues = model.groups.map((group) => group.value);
    const visited = await navigateList(
      [ARROW_DOWN, ARROW_DOWN],
      phaseValues[0]!,
      WIDE_COLUMNS,
    );

    expect(visited).toStrictEqual(phaseValues.slice(1));
    for (const value of visited) expect(model.listValues).toContain(value);
  });

  it('enters a phase at a task row that exists in the same row list', async () => {
    const model = workflowDashboardModel(TWO_PHASE_ROOT, WIDE_COLUMNS);
    const secondGroup = model.groups[1]!;
    const visited = await navigateList(
      [ARROW_RIGHT],
      secondGroup.value,
      WIDE_COLUMNS,
    );

    expect(visited).toStrictEqual([`workflowTask:${secondGroup.tasks[0]!.id}`]);
    expect(model.listValues).toContain(visited[0]);
  });
});
