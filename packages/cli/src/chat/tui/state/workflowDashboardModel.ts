// Single derivation of the workflow-dashboard rows.
//
// Two consumers read the same dashboard and must agree on row identity and
// order: `App` drives the child-list selection reducer, the Alt/Esc-1..9 focus
// path, and the bare-Escape walk from it, while `SubagentList` renders it.
// Deriving the rows twice is exactly how keyboard numbering silently desyncs
// from what is on screen, so both read this module and neither regroups,
// re-sorts, or re-dedupes on its own.

// Local imports - shared stream identity
import type { StreamTabId } from '@shared/schemas';
import type { TranscriptRowOf } from '@shared/transcript';
import type { WorkflowPhaseHeading } from '@shared/copy/workflowCall';

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
  readonly label: string;
  /** The phase's own heading facts, once a phase row has named it. */
  readonly heading?: WorkflowPhaseHeading;
  readonly tasks: readonly WorkflowTaskEntry[];
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
  /** Phase groups in first-appearance order; tasks stay in transcript order. */
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
  readonly label: string;
  heading?: WorkflowPhaseHeading;
  readonly tasks: WorkflowTaskEntry[];
}

/** Heading facts of one phase row, with counts omitted by the row (a
 *  GROUP_END row can omit them) retained from the previous heading. */
function phaseHeading(
  entry: TranscriptRowOf<'phase'>,
  previous: WorkflowPhaseHeading | undefined,
): WorkflowPhaseHeading {
  const phaseIndex = entry.phaseIndex ?? previous?.phaseIndex;
  const phaseTotal = entry.phaseTotal ?? previous?.phaseTotal;
  return {
    phaseLabel: entry.phaseLabel,
    ...(phaseIndex !== undefined ? { phaseIndex } : {}),
    ...(phaseTotal !== undefined ? { phaseTotal } : {}),
  };
}

/** Derive the dashboard rows for one workflow root at one terminal width. */
export function workflowDashboardModel(
  root: StreamSlice,
  columns: number,
): WorkflowDashboardModel {
  const groups: MutableWorkflowPhaseGroup[] = [];
  const byPhase = new Map<string | undefined, MutableWorkflowPhaseGroup>();
  const tasks: WorkflowTaskEntry[] = [];
  // The transcript fold already holds exactly the current attempt's rows
  // (`transcriptFold.ts`), one per logical call, so no re-selection here.
  for (const entry of root.entries) {
    if (entry.kind !== 'phase' && entry.kind !== 'workflowTask') continue;
    const phase = entry.kind === 'phase' ? entry.phaseLabel : entry.call.phase;
    let group = byPhase.get(phase);
    if (!group) {
      group = {
        value: workflowPhaseListValue(entry.id),
        label: phase ?? 'Unphased',
        ...(entry.kind === 'phase'
          ? { heading: phaseHeading(entry, undefined) }
          : {}),
        tasks: [],
      };
      byPhase.set(phase, group);
      groups.push(group);
    } else if (entry.kind === 'phase') {
      // A rerun may retain the same phase label with revised index/total data.
      // Keep the stable first-appearance row identity, but display the latest
      // heading facts just as the status band does.
      group.heading = phaseHeading(entry, group.heading);
    }
    if (entry.kind === 'workflowTask') {
      group.tasks.push(entry);
      tasks.push(entry);
    }
  }

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
  const narrowValues = groups.flatMap((group) =>
    group.tasks.length === 0
      ? [group.value]
      : group.tasks.map((entry) => workflowTaskListValue(entry.id)),
  );
  const wide = columns >= WORKFLOW_DASHBOARD_WIDE_MIN_COLUMNS;
  return {
    root,
    groups,
    tasks,
    childTaskIndex,
    taskByValue: new Map(
      tasks.map((entry) => [workflowTaskListValue(entry.id), entry]),
    ),
    groupByValue: new Map(groups.map((group) => [group.value, group])),
    // Narrow phase headers with tasks are disabled separators. An empty phase
    // is itself selectable so a phase-only dashboard remains keyboard-reachable.
    listValues: wide
      ? [...groups.map((group) => group.value), ...taskValues]
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
    return 1 + model.groups.length + model.tasks.length;
  }
  const { activeGroup } = workflowDashboardSelection(model, selectedValue);
  return 1 + Math.max(model.groups.length, activeGroup?.tasks.length ?? 0);
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
