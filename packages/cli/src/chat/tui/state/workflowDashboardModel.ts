// Single derivation of a workflow run's phases and rows.
//
// The popup renders it and `App` resolves focus targets from it, so the two
// must agree on row identity and order: both read this module and neither
// regroups, re-sorts, or re-dedupes on its own.

// Local imports - shared stream identity
import type {
  StreamTabId,
  WorkflowCallIdentity,
  WorkflowCallProgress,
  WorkflowPlanMarker,
} from '@shared/schemas';
import { WORKFLOW_TASK_STATUS_LABEL } from '@shared/schemas';
import type { TranscriptRowOf } from '@shared/transcript';
import {
  latestWorkflowAttemptEntries,
  workflowPhaseHeadingOfGroup,
  type WorkflowPhaseHeading,
} from '@shared/copy/workflowCall';

// Local imports - TUI state
import type { StreamSlice, WorkflowPopupGroupKind } from './cliState';

export type WorkflowTaskEntry = TranscriptRowOf<'workflowTask'>;

export interface WorkflowPhaseGroup {
  /** Stable row identity: the task group id, or `declared-<title>` for a
   *  phase known only from the plan. */
  readonly key: string;
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
  /** Phase groups in plan order, then the order the run opened them; tasks
   *  stay in transcript order. */
  readonly groups: readonly WorkflowPhaseGroup[];
  /** Every task, in transcript-entry order. */
  readonly tasks: readonly WorkflowTaskEntry[];
  readonly childTaskIndex: WorkflowChildTaskIndex;
}

interface MutableWorkflowPhaseGroup {
  readonly key: string;
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
  const unphasedDeclared: WorkflowCallIdentity[] = [];
  for (const task of plan.tasks) {
    if (cardIds.has(task.id)) continue;
    if (task.phase === undefined) {
      unphasedDeclared.push(task);
      continue;
    }
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
        key: `declared-${phase.title}`,
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
  // Plan tasks declared outside any phase sit under the same trailing
  // "Unphased" heading their cards will use once issued.
  if (unphasedDeclared.length > 0) {
    ordered.push({
      key: 'declared-unphased',
      heading: { phaseLabel: 'Unphased' },
      tasks: [],
      opened: false,
      declaredTasks: unphasedDeclared,
    });
  }
  return ordered;
}

/** Derive the phases and rows for one workflow root.
 *
 *  Phases are the run's own `phase` task groups, and a call joins the group
 *  its `groupId` names — the same classification the progress view's group
 *  tree makes (`messageIndex.rebuildTree`). Grouping by the call's `phase`
 *  *label* instead would fuse two same-named phases and lose a phase the
 *  script opened but never filled. */
export function workflowDashboardModel(
  root: StreamSlice,
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
      key: group.id,
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
  // The board leaves such a row ungrouped in the root timeline; the popup is
  // a phase list, so it collects them into one trailing group rather than
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
      key: `unphased-${entry.id}`,
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

  return { root, groups: survivingGroups, tasks, childTaskIndex };
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

// ---------------------------------------------------------------------------
// Popup rows: attention first, volume collapsed
// ---------------------------------------------------------------------------

export type WorkflowPopupRow =
  | {
      readonly kind: 'task';
      readonly key: string;
      readonly entry: WorkflowTaskEntry;
    }
  | {
      readonly kind: 'declared';
      readonly key: string;
      readonly task: WorkflowCallIdentity;
    }
  | {
      readonly kind: 'group';
      readonly key: string;
      readonly group: WorkflowPopupGroupKind;
      readonly count: number;
      readonly expanded: boolean;
    };

/** Rows that need a decision lead, rows worth watching follow; everything
 *  else is a counted group. Lower sorts first. */
const ATTENTION_RANK: Partial<Record<WorkflowCallProgress['status'], number>> =
  {
    awaitingApproval: 0,
    failed: 1,
    running: 2,
  };

const QUEUED_STATUSES: ReadonlySet<WorkflowCallProgress['status']> = new Set([
  'planned',
  'queued',
]);

function popupGroupOf(
  status: WorkflowCallProgress['status'],
): 'queued' | 'done' | undefined {
  if (status in ATTENTION_RANK) return undefined;
  return QUEUED_STATUSES.has(status) ? 'queued' : 'done';
}

function workflowPopupTaskKey(entry: WorkflowTaskEntry): string {
  return `task:${entry.id}`;
}

function declaredKey(task: WorkflowCallIdentity): string {
  return `declared:${task.id}`;
}

function matchesFilter(
  filter: string,
  ...texts: readonly (string | undefined)[]
): boolean {
  return texts.some((text) => text?.toLowerCase().includes(filter));
}

/**
 * One phase's rows for the popup. With a filter every matching task is one
 * flat row; without one, rows needing attention (awaiting approval, failed,
 * running — in that order, transcript order within) lead, and the rest
 * collapse into `queued` / `done` / `declared` groups that open in place.
 * Screen rows scale with states, not with agents.
 */
export function workflowPopupRows(
  group: WorkflowPhaseGroup,
  view: {
    readonly expanded: ReadonlySet<WorkflowPopupGroupKind>;
    readonly filter: string;
  },
): readonly WorkflowPopupRow[] {
  const filter = view.filter.trim().toLowerCase();
  if (filter.length > 0) {
    return [
      ...group.tasks
        .filter((entry) =>
          matchesFilter(
            filter,
            entry.call.label,
            entry.call.agent,
            WORKFLOW_TASK_STATUS_LABEL[entry.call.status],
          ),
        )
        .map((entry): WorkflowPopupRow => ({
          kind: 'task',
          key: workflowPopupTaskKey(entry),
          entry,
        })),
      ...group.declaredTasks
        .filter((task) =>
          matchesFilter(
            filter,
            task.label,
            WORKFLOW_TASK_STATUS_LABEL.declared,
          ),
        )
        .map((task): WorkflowPopupRow => ({
          kind: 'declared',
          key: declaredKey(task),
          task,
        })),
    ];
  }

  const attention: WorkflowTaskEntry[] = [];
  const grouped: Record<'queued' | 'done', WorkflowTaskEntry[]> = {
    queued: [],
    done: [],
  };
  for (const entry of group.tasks) {
    const bucket = popupGroupOf(entry.call.status);
    if (bucket === undefined) attention.push(entry);
    else grouped[bucket].push(entry);
  }
  // Stable within a rank: `toSorted` keeps transcript order for equal keys.
  const attentionRows = attention
    .toSorted(
      (a, b) =>
        (ATTENTION_RANK[a.call.status] ?? 0) -
        (ATTENTION_RANK[b.call.status] ?? 0),
    )
    .map((entry): WorkflowPopupRow => ({
      kind: 'task',
      key: workflowPopupTaskKey(entry),
      entry,
    }));

  const groupRows = (
    kind: WorkflowPopupGroupKind,
    members: readonly WorkflowPopupRow[],
  ): readonly WorkflowPopupRow[] => {
    if (members.length === 0) return [];
    const expanded = view.expanded.has(kind);
    const header: WorkflowPopupRow = {
      kind: 'group',
      key: `group:${kind}`,
      group: kind,
      count: members.length,
      expanded,
    };
    return expanded ? [header, ...members] : [header];
  };
  const taskRows = (entries: readonly WorkflowTaskEntry[]) =>
    entries.map((entry): WorkflowPopupRow => ({
      kind: 'task',
      key: workflowPopupTaskKey(entry),
      entry,
    }));
  return [
    ...attentionRows,
    ...groupRows('queued', taskRows(grouped.queued)),
    ...groupRows('done', taskRows(grouped.done)),
    ...groupRows(
      'declared',
      group.declaredTasks.map((task): WorkflowPopupRow => ({
        kind: 'declared',
        key: declaredKey(task),
        task,
      })),
    ),
  ];
}
