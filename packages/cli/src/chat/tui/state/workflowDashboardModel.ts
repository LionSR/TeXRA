// Single derivation of the workflow-dashboard rows.
//
// Two consumers read the same dashboard and must agree on row identity and
// order: `App` drives the child-list selection reducer, the Alt/Esc-1..9 focus
// path, and the bare-Escape walk from it, while `SubagentList` renders it.
// Deriving the rows twice is exactly how keyboard numbering silently desyncs
// from what is on screen, so both read this module and neither regroups,
// re-sorts, or re-dedupes on its own.

// Local imports - shared stream identity
import type {
  StreamTabId,
  WorkflowCallIdentity,
  WorkflowPlanMarker,
} from '@shared/schemas';
import type { TranscriptRowOf } from '@shared/transcript';
import {
  latestWorkflowAttemptEntries,
  workflowPhaseHeadingOfGroup,
  type WorkflowPhaseHeading,
} from '@shared/copy/workflowCall';

// Local imports - TUI presentation constants
import { WORKFLOW_DASHBOARD_WIDE_MIN_COLUMNS } from '../panes/SubagentListDisplay';

// Local imports - TUI state
import {
  workflowPhaseListValue,
  workflowTaskListValue,
  type ChildListValue,
} from './childListSelection';
import type { StreamSlice } from './cliState';

export type WorkflowTaskEntry = TranscriptRowOf<'workflowTask'>;

export interface WorkflowPhaseGroup {
  readonly value: ChildListValue;
  /** The phase's own heading facts, as its `TaskGroup` states them — or as
   *  the declared plan states them for a phase the run has not opened. */
  readonly heading: WorkflowPhaseHeading;
  readonly tasks: readonly WorkflowTaskEntry[];
  /** True once the run has opened this phase (it has a `TaskGroup`); false
   *  for a phase known only from the declared plan. */
  readonly opened: boolean;
  /** Declared plan tasks in this phase the run has not issued as calls yet —
   *  every plan task without a card. Empty for a dynamic script. */
  readonly declaredTasks: readonly WorkflowCallIdentity[];
}

/** A task's child stream, or `null` when several tasks claim the same stream.
 *  Ambiguous rows own no stream: focusing one would jump somewhere the user
 *  did not point at. */
type WorkflowChildTaskIndex = ReadonlyMap<
  StreamTabId,
  WorkflowTaskEntry | null
>;

export interface WorkflowDashboardModel {
  /** The workflow stream the dashboard is rooted on. */
  readonly root: StreamSlice;
  /** Phase groups in the order the run opened them; tasks stay in transcript
   *  order. */
  readonly groups: readonly WorkflowPhaseGroup[];
  /** Every task, in transcript-entry order. */
  readonly tasks: readonly WorkflowTaskEntry[];
  readonly childTaskIndex: WorkflowChildTaskIndex;
  readonly taskByValue: ReadonlyMap<ChildListValue, WorkflowTaskEntry>;
  readonly groupByValue: ReadonlyMap<ChildListValue, WorkflowPhaseGroup>;
  /** Row values the child-list selection reducer reconciles against. Phase
   *  rows only participate while the two-column layout shows them.
   *
   *  Task values keep transcript order, which equals the narrow list's grouped
   *  render order for every workflow whose same-phase tasks are contiguous —
   *  the shape every current workflow emits. A workflow that interleaved two
   *  phases would seed the reducer's default row from the transcript-first
   *  task while the narrow list highlights the first group's first task; that
   *  divergence predates this module and is deliberately preserved here rather
   *  than changed inside a refactor. */
  readonly listValues: readonly ChildListValue[];
  /** True while the two-column (phases | tasks) layout is in effect. */
  readonly wide: boolean;
}

interface MutableWorkflowPhaseGroup {
  readonly value: ChildListValue;
  readonly heading: WorkflowPhaseHeading;
  readonly tasks: WorkflowTaskEntry[];
  readonly opened: boolean;
  declaredTasks: readonly WorkflowCallIdentity[];
}

/**
 * Fill the run's opened phases in with its declared plan: a plan phase with no
 * task group yet becomes a declared group in plan order, a plan task with no
 * card lands under its phase as a declared task, and opened phases the plan
 * never named (dynamic `phase()` calls) keep their run order after it. A card
 * always wins over its plan entry, so nothing is listed twice.
 */
function unionWithDeclaredPlan(
  opened: readonly MutableWorkflowPhaseGroup[],
  plan: WorkflowPlanMarker,
  cards: readonly WorkflowTaskEntry[],
  runSettled: boolean,
): readonly MutableWorkflowPhaseGroup[] {
  const cardIds = new Set(cards.map((entry) => entry.call.id));
  const declaredByPhase = new Map<string, WorkflowCallIdentity[]>();
  for (const task of plan.tasks) {
    if (task.phase === undefined || cardIds.has(task.id)) continue;
    const list = declaredByPhase.get(task.phase) ?? [];
    list.push(task);
    declaredByPhase.set(task.phase, list);
  }
  const byTitle = new Map(
    opened.map((group) => [group.heading.phaseLabel, group] as const),
  );
  const ordered: MutableWorkflowPhaseGroup[] = [];
  const placed = new Set<MutableWorkflowPhaseGroup>();
  for (const phase of plan.phases) {
    const declaredTasks = declaredByPhase.get(phase.title) ?? [];
    let group = byTitle.get(phase.title);
    if (!group) {
      // A settled run never opens a phase it did not reach, and its settle
      // sweep has already housed every declared card under a stage — so an
      // empty plan-only phase after settlement is the bridge's own
      // skipped-empty-phase suppression, and stays gone.
      if (runSettled && declaredTasks.length === 0) continue;
      group = {
        value: workflowPhaseListValue(`declared-${phase.title}`),
        heading: {
          phaseLabel: phase.title,
          phaseIndex: phase.index,
          phaseTotal: plan.phases.length,
        },
        tasks: [],
        opened: false,
        declaredTasks: [],
      };
    }
    group.declaredTasks = declaredTasks;
    ordered.push(group);
    placed.add(group);
  }
  for (const group of opened) {
    if (!placed.has(group)) ordered.push(group);
  }
  return ordered;
}

/** Derive the dashboard rows for one workflow root at one terminal width.
 *
 *  Phases are the run's own `phase` task groups, and a call joins the group
 *  its `groupId` names — the same classification the progress view's group
 *  tree makes (`messageIndex.rebuildTree`). Grouping by the call's `phase`
 *  *label* instead would fuse two same-named phases and lose a phase the
 *  script opened but never filled. */
export function workflowDashboardModel(
  root: StreamSlice,
  columns: number,
  options: {
    /** True once the workflow run has ended: plan-only phases it never
     *  reached are then nothing to show. */
    readonly runSettled?: boolean;
  } = {},
): WorkflowDashboardModel {
  const groups: MutableWorkflowPhaseGroup[] = [];
  const byGroupId = new Map<string, MutableWorkflowPhaseGroup>();
  for (const group of root.taskGroups) {
    if (group.kind !== 'phase') continue;
    const phaseGroup: MutableWorkflowPhaseGroup = {
      value: workflowPhaseListValue(group.id),
      heading: workflowPhaseHeadingOfGroup(group),
      tasks: [],
      opened: true,
      declaredTasks: [],
    };
    groups.push(phaseGroup);
    byGroupId.set(group.id, phaseGroup);
  }
  // A relaunch under the same meta.name appends a second projection attempt
  // to the same transcript with fresh card ids; scope to the newest attempt
  // so a resume's live totals and rows don't fold a superseded attempt's
  // cards in with the one actually running (see latestWorkflowAttemptEntries).
  const allWorkflowTaskEntries = root.entries.filter(
    (entry): entry is WorkflowTaskEntry => entry.kind === 'workflowTask',
  );
  const scopedIds = new Set(
    latestWorkflowAttemptEntries(
      allWorkflowTaskEntries,
      (entry) => entry.call.attemptId,
    ).map((entry) => entry.id),
  );

  const tasks: WorkflowTaskEntry[] = [];
  // A call the run issued outside any open phase has no group to sit under.
  // The board leaves such a row ungrouped in the root timeline; the dashboard
  // is a phase list, so it collects them into one trailing group rather than
  // dropping rows the keyboard could otherwise never reach.
  let ungrouped: MutableWorkflowPhaseGroup | undefined;
  // A phase whose every task belonged to a superseded attempt is the
  // resume's duplicate phase row (fresh stage ids per phase per attempt), not
  // a genuinely empty phase — tracked so it can be dropped below rather than
  // showing a same-titled phase with nothing in it.
  const groupsWithStaleTasks = new Set<MutableWorkflowPhaseGroup>();
  for (const entry of allWorkflowTaskEntries) {
    const group = entry.groupId ? byGroupId.get(entry.groupId) : undefined;
    if (!scopedIds.has(entry.id)) {
      if (group) groupsWithStaleTasks.add(group);
      continue;
    }
    tasks.push(entry);
    if (group) {
      group.tasks.push(entry);
      continue;
    }
    ungrouped ??= {
      value: workflowPhaseListValue(entry.id),
      heading: { phaseLabel: 'Unphased' },
      tasks: [],
      opened: true,
      declaredTasks: [],
    };
    ungrouped.tasks.push(entry);
  }
  const openedGroups = groups.filter(
    (group) => group.tasks.length > 0 || !groupsWithStaleTasks.has(group),
  );
  const survivingGroups = [
    ...(root.workflowPlan
      ? unionWithDeclaredPlan(
          openedGroups,
          root.workflowPlan,
          tasks,
          options.runSettled === true,
        )
      : openedGroups),
  ];
  if (ungrouped) survivingGroups.push(ungrouped);

  const childTaskIndex = new Map<StreamTabId, WorkflowTaskEntry | null>();
  for (const entry of tasks) {
    const childStreamId = entry.call.childStreamId;
    if (childStreamId === undefined) continue;
    childTaskIndex.set(
      childStreamId,
      childTaskIndex.has(childStreamId) ? null : entry,
    );
  }

  const taskValues = tasks.map((entry) => workflowTaskListValue(entry.id));
  const narrowValues = survivingGroups.flatMap((group) =>
    group.tasks.length === 0
      ? [group.value]
      : group.tasks.map((entry) => workflowTaskListValue(entry.id)),
  );
  const wide = columns >= WORKFLOW_DASHBOARD_WIDE_MIN_COLUMNS;
  return {
    root,
    groups: survivingGroups,
    tasks,
    childTaskIndex,
    taskByValue: new Map(
      tasks.map((entry) => [workflowTaskListValue(entry.id), entry]),
    ),
    groupByValue: new Map(survivingGroups.map((group) => [group.value, group])),
    // Narrow phase headers with tasks are disabled separators. An empty phase
    // is itself selectable so a phase-only dashboard remains keyboard-reachable.
    listValues: wide
      ? [...survivingGroups.map((group) => group.value), ...taskValues]
      : narrowValues,
    wide,
  };
}

/** Number of content rows the dashboard can display at the current width.
 *  `undefined` (no workflow root) reserves no rows at all. */
export function workflowDashboardPanelItemCount(
  model: WorkflowDashboardModel | undefined,
  selectedValue: ChildListValue | undefined,
  rootHasApproval: boolean,
): number {
  if (!model) return 0;
  if (model.groups.length === 0 && model.tasks.length === 0) {
    return rootHasApproval ? 1 : 0;
  }
  if (!model.wide) {
    // Declared rows sit under their phase in the narrow list too.
    return (
      1 +
      model.groups.length +
      model.tasks.length +
      model.groups.reduce((sum, group) => sum + group.declaredTasks.length, 0)
    );
  }
  const { activeGroup } = workflowDashboardSelection(model, selectedValue);
  const taskColumnRows =
    (activeGroup?.tasks.length ?? 0) + (activeGroup?.declaredTasks.length ?? 0);
  return 1 + Math.max(model.groups.length, taskColumnRows);
}

interface WorkflowDashboardSelection {
  readonly selectedGroup: WorkflowPhaseGroup | undefined;
  readonly selectedTask: WorkflowTaskEntry | undefined;
  readonly selectedTaskGroup: WorkflowPhaseGroup | undefined;
  /** Group whose tasks the task column shows. */
  readonly activeGroup: WorkflowPhaseGroup | undefined;
}

/** Resolve what one selected row means for the dashboard. Shared so the row
 *  budget reserved for the panel and the rows the panel actually renders are
 *  computed from the same active group. */
export function workflowDashboardSelection(
  model: WorkflowDashboardModel,
  selectedValue: ChildListValue | undefined,
): WorkflowDashboardSelection {
  const selectedGroup = selectedValue
    ? model.groupByValue.get(selectedValue)
    : undefined;
  const selectedTask = selectedValue
    ? model.taskByValue.get(selectedValue)
    : undefined;
  const selectedTaskGroup = selectedTask
    ? model.groups.find((group) => group.tasks.includes(selectedTask))
    : undefined;
  return {
    selectedGroup,
    selectedTask,
    selectedTaskGroup,
    activeGroup: selectedGroup ?? selectedTaskGroup ?? model.groups[0],
  };
}

/** The task's child stream when this task is its only claimant and the stream
 *  exists; otherwise the row owns no stream to focus. */
export function uniqueWorkflowChildStreamId(
  entry: WorkflowTaskEntry,
  childTaskIndex: WorkflowChildTaskIndex,
  streams: ReadonlyMap<StreamTabId, StreamSlice>,
): StreamTabId | undefined {
  const childStreamId = entry.call.childStreamId;
  return childStreamId !== undefined &&
    childTaskIndex.get(childStreamId) === entry &&
    streams.has(childStreamId)
    ? childStreamId
    : undefined;
}
