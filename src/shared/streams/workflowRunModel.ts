// One model of a workflow-script run for every host.
//
// A `dispatch_multi_agent` run is the same set of facts on the terminal and on
// the progress board: the phases the run opened (`TaskGroup`s of kind
// `phase`), the call cards the projection emitted (`workflowTask` transcript
// rows), the plan the script declared (`workflowPlan` marker), and whether the
// run has settled. This module folds those facts once — phase order, attempt
// scoping, the declared-plan union, tallies, the per-call status cells, which
// card may open which child stream, and the attention-first row order of a
// phase. Hosts render the result; they never regroup, re-sort, or re-count.

// Local imports - shared schemas and copy
import {
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  WORKFLOW_TASK_STATUS_LABEL,
  WorkflowPlanMarkerSchema,
  type StreamLogEntry,
  type StreamTabId,
  type TaskGroup,
  type WorkflowCallIdentity,
  type WorkflowCallProgress,
  type WorkflowPlanMarker,
} from '@shared/schemas';
import {
  latestWorkflowAttemptEntries,
  workflowCallTally,
  workflowPhaseHeadingOfGroup,
  type WorkflowPhaseHeading,
} from '@shared/copy/workflowCall';
import type { TranscriptRow, WorkflowTaskRow } from '@shared/transcript';

// ---------------------------------------------------------------------------
// Markers on the transcript
// ---------------------------------------------------------------------------

/** What an `INTERNAL` transcript entry says about the workflow run. */
export type WorkflowMarker =
  | { readonly kind: 'attempt' }
  | { readonly kind: 'plan'; readonly plan: WorkflowPlanMarker }
  | { readonly kind: 'malformedPlan'; readonly error: string };

function internalMarkerKind(data: unknown): unknown {
  return typeof data === 'object' && data !== null
    ? (data as { readonly kind?: unknown }).kind
    : undefined;
}

/**
 * Read the workflow marker one transcript entry carries, if any. Every host
 * folds these the same way: a new attempt starts with no plan until it records
 * one (an attempt that fails before then must not inherit its predecessor's),
 * and a malformed plan is an unknown plan, not the previous attempt's.
 */
export function workflowMarkerOf(
  entry: StreamLogEntry,
): WorkflowMarker | undefined {
  if (
    entry.type !== STREAM_LOG_ENTRY_TYPES.LOG ||
    entry.messageType !== MESSAGE_TYPES.INTERNAL
  ) {
    return undefined;
  }
  const kind = internalMarkerKind(entry.data);
  if (kind === 'workflowAttempt') return { kind: 'attempt' };
  if (kind !== 'workflowPlan') return undefined;
  const parsed = WorkflowPlanMarkerSchema.safeParse(entry.data);
  return parsed.success
    ? { kind: 'plan', plan: parsed.data }
    : { kind: 'malformedPlan', error: parsed.error.message };
}

// ---------------------------------------------------------------------------
// The run model
// ---------------------------------------------------------------------------

/** `done/total`, the live counts, and how many plan tasks are still unissued. */
interface WorkflowTally {
  readonly done: number;
  readonly total: number;
  readonly running: number;
  readonly failed: number;
  readonly declared: number;
}

export interface WorkflowPhaseModel {
  /** Stable identity: the task group id, or `declared-<title>` for a phase
   *  known only from the plan. */
  readonly key: string;
  /** The phase's heading facts, from its `TaskGroup` or from the plan. */
  readonly heading: WorkflowPhaseHeading;
  /** True once the run has opened this phase (it has a `TaskGroup`). */
  readonly opened: boolean;
  /** This phase's cards from the newest attempt, in transcript order. */
  readonly tasks: readonly WorkflowTaskRow[];
  /** Plan tasks in this phase the run has not issued yet — every plan task
   *  without a card. Empty for a dynamic script. */
  readonly declaredTasks: readonly WorkflowCallIdentity[];
  readonly tally: WorkflowTally;
  /** One status per card in issue order — the phase's status strip. */
  readonly cells: readonly WorkflowCallProgress['status'][];
}

export interface WorkflowRunModel {
  /** Phases in plan order, then the order the run opened the rest. */
  readonly phases: readonly WorkflowPhaseModel[];
  /** Every card of the newest attempt, in transcript order. */
  readonly tasks: readonly WorkflowTaskRow[];
  readonly tally: WorkflowTally;
  /** The child stream a card may open, by row id: its `childStreamId` when
   *  that card is the stream's only claimant. A stream two cards claim is
   *  nobody's — opening it would jump somewhere the user did not point at. */
  readonly childStreamOf: ReadonlyMap<string, StreamTabId>;
}

export interface WorkflowRunModelInput {
  readonly taskGroups: readonly TaskGroup[];
  /** The stream's rows; the model picks the `workflowTask` ones. */
  readonly rows: readonly TranscriptRow[];
  /** The newest attempt's declared plan, if the transcript recorded one. */
  readonly plan: WorkflowPlanMarker | undefined;
  /** True once the run has ended: plan-only phases it never reached are then
   *  nothing to show (the projection's settle sweep has housed every declared
   *  card under a stage, so an empty plan-only phase is its own
   *  skipped-empty-phase suppression). */
  readonly runSettled: boolean;
}

interface MutablePhase {
  readonly key: string;
  readonly heading: WorkflowPhaseHeading;
  readonly tasks: WorkflowTaskRow[];
  readonly opened: boolean;
  declaredTasks: readonly WorkflowCallIdentity[];
}

function tallyOf(
  tasks: readonly WorkflowTaskRow[],
  declared: number,
): WorkflowTally {
  return { ...workflowCallTally(tasks.map((row) => row.call)), declared };
}

/**
 * Fill the run's opened phases in with its declared plan: a plan phase with no
 * task group yet becomes a declared phase in plan order, a plan task with no
 * card lands under its phase as a declared task, and opened phases the plan
 * never named (dynamic `phase()` calls) keep their run order after it. A card
 * always wins over its plan entry, so nothing is listed twice.
 */
function unionWithDeclaredPlan(
  opened: readonly MutablePhase[],
  plan: WorkflowPlanMarker,
  cards: readonly WorkflowTaskRow[],
  runSettled: boolean,
): readonly MutablePhase[] {
  const cardIds = new Set(cards.map((row) => row.call.id));
  const declaredByPhase = new Map<string, WorkflowCallIdentity[]>();
  const unphased: WorkflowCallIdentity[] = [];
  for (const task of plan.tasks) {
    if (cardIds.has(task.id)) continue;
    if (task.phase === undefined) {
      unphased.push(task);
      continue;
    }
    const list = declaredByPhase.get(task.phase) ?? [];
    list.push(task);
    declaredByPhase.set(task.phase, list);
  }
  const byTitle = new Map(
    opened.map((phase) => [phase.heading.phaseLabel, phase] as const),
  );
  const ordered: MutablePhase[] = [];
  const placed = new Set<MutablePhase>();
  for (const declared of plan.phases) {
    const declaredTasks = declaredByPhase.get(declared.title) ?? [];
    let phase = byTitle.get(declared.title);
    if (!phase) {
      if (runSettled && declaredTasks.length === 0) continue;
      phase = {
        key: `declared-${declared.title}`,
        heading: {
          phaseLabel: declared.title,
          phaseIndex: declared.index,
          phaseTotal: plan.phases.length,
        },
        tasks: [],
        opened: false,
        declaredTasks: [],
      };
    }
    phase.declaredTasks = declaredTasks;
    ordered.push(phase);
    placed.add(phase);
  }
  for (const phase of opened) {
    if (!placed.has(phase)) ordered.push(phase);
  }
  // Plan tasks declared outside any phase sit under the same trailing
  // "Unphased" heading their cards will use once issued.
  if (unphased.length > 0) {
    ordered.push({
      key: 'declared-unphased',
      heading: { phaseLabel: 'Unphased' },
      tasks: [],
      opened: false,
      declaredTasks: unphased,
    });
  }
  return ordered;
}

/**
 * Fold one run's facts. Phases are the run's own `phase` task groups, and a
 * card joins the group its `groupId` names — the classification both hosts
 * have always made. Grouping by the card's `phase` *label* instead would fuse
 * two same-named phases and lose a phase the script opened but never filled.
 */
export function workflowRunModel(
  input: WorkflowRunModelInput,
): WorkflowRunModel {
  const phases: MutablePhase[] = [];
  const byGroupId = new Map<string, MutablePhase>();
  for (const group of input.taskGroups) {
    if (group.kind !== 'phase') continue;
    const phase: MutablePhase = {
      key: group.id,
      heading: workflowPhaseHeadingOfGroup(group),
      tasks: [],
      opened: true,
      declaredTasks: [],
    };
    phases.push(phase);
    byGroupId.set(group.id, phase);
  }
  // A relaunch under the same meta.name appends a second projection attempt
  // to the same transcript with fresh card ids; scope to the newest attempt
  // so a resume's live rows and totals never fold a superseded attempt's
  // cards in with the one actually running.
  const cards = input.rows.filter(
    (row): row is WorkflowTaskRow => row.kind === 'workflowTask',
  );
  const liveIds = new Set(
    latestWorkflowAttemptEntries(cards, (row) => row.call.attemptId).map(
      (row) => row.id,
    ),
  );
  const tasks: WorkflowTaskRow[] = [];
  // A card issued outside any open phase has no group to sit under; it joins
  // one trailing "Unphased" phase rather than vanishing.
  let unphased: MutablePhase | undefined;
  // A phase whose every card belonged to a superseded attempt is the resume's
  // duplicate phase row (fresh stage ids per phase per attempt), not a
  // genuinely empty phase — dropped below rather than shown empty.
  const staleOnly = new Set<MutablePhase>();
  for (const row of cards) {
    const phase = row.groupId ? byGroupId.get(row.groupId) : undefined;
    if (!liveIds.has(row.id)) {
      if (phase) staleOnly.add(phase);
      continue;
    }
    tasks.push(row);
    if (phase) {
      phase.tasks.push(row);
      continue;
    }
    unphased ??= {
      key: `unphased-${row.id}`,
      heading: { phaseLabel: 'Unphased' },
      tasks: [],
      opened: true,
      declaredTasks: [],
    };
    unphased.tasks.push(row);
  }
  const opened = phases.filter(
    (phase) => phase.tasks.length > 0 || !staleOnly.has(phase),
  );
  const ordered = [
    ...(input.plan
      ? unionWithDeclaredPlan(opened, input.plan, tasks, input.runSettled)
      : opened),
  ];
  if (unphased) ordered.push(unphased);

  const claimants = new Map<StreamTabId, WorkflowTaskRow | null>();
  for (const row of tasks) {
    const childStreamId = row.call.childStreamId;
    if (childStreamId === undefined) continue;
    claimants.set(childStreamId, claimants.has(childStreamId) ? null : row);
  }
  const childStreamOf = new Map<string, StreamTabId>();
  for (const [childStreamId, row] of claimants) {
    if (row) childStreamOf.set(row.id, childStreamId);
  }

  const declaredTotal = ordered.reduce(
    (sum, phase) => sum + phase.declaredTasks.length,
    0,
  );
  return {
    phases: ordered.map((phase) => ({
      ...phase,
      tally: tallyOf(phase.tasks, phase.declaredTasks.length),
      cells: phase.tasks.map((row) => row.call.status),
    })),
    tasks,
    tally: tallyOf(tasks, declaredTotal),
    childStreamOf,
  };
}

// ---------------------------------------------------------------------------
// A phase's rows: attention first, volume collapsed
// ---------------------------------------------------------------------------

/** The counted groups a phase's quiet rows collapse into. */
export type WorkflowRowGroup = 'queued' | 'done' | 'declared';

export type WorkflowPhaseRow =
  | {
      readonly kind: 'task';
      readonly key: string;
      readonly row: WorkflowTaskRow;
    }
  | {
      readonly kind: 'declared';
      readonly key: string;
      readonly task: WorkflowCallIdentity;
    }
  | {
      readonly kind: 'group';
      readonly key: string;
      readonly group: WorkflowRowGroup;
      readonly count: number;
      readonly expanded: boolean;
    };

/** Rows that need a decision lead, rows worth watching follow. */
const ATTENTION_STATUSES = ['awaitingApproval', 'failed', 'running'] as const;
type AttentionStatus = (typeof ATTENTION_STATUSES)[number];
const ATTENTION_RANK: Record<AttentionStatus, number> = {
  awaitingApproval: 0,
  failed: 1,
  running: 2,
};

function isAttentionStatus(
  status: WorkflowCallProgress['status'],
): status is AttentionStatus {
  return (ATTENTION_STATUSES as readonly string[]).includes(status);
}

const QUEUED_STATUSES: ReadonlySet<WorkflowCallProgress['status']> = new Set([
  'planned',
  'queued',
]);

function taskRowOf(row: WorkflowTaskRow): WorkflowPhaseRow {
  return { kind: 'task', key: `task:${row.id}`, row };
}

function declaredRowOf(task: WorkflowCallIdentity): WorkflowPhaseRow {
  return { kind: 'declared', key: `declared:${task.id}`, task };
}

function matchesFilter(
  filter: string,
  ...texts: readonly (string | undefined)[]
): boolean {
  return texts.some((text) => text?.toLowerCase().includes(filter));
}

/**
 * One phase's rows. With a filter every matching card is one flat row;
 * without one, cards needing attention (awaiting approval, failed, running —
 * in that order, transcript order within) lead, and the rest collapse into
 * `queued` / `done` / `declared` groups that open in place. Screen rows scale
 * with states, not with agents.
 */
export function workflowPhaseRows(
  phase: WorkflowPhaseModel,
  view: {
    readonly expanded: ReadonlySet<WorkflowRowGroup>;
    readonly filter: string;
  },
): readonly WorkflowPhaseRow[] {
  const filter = view.filter.trim().toLowerCase();
  if (filter.length > 0) {
    return [
      ...phase.tasks
        .filter((row) =>
          matchesFilter(
            filter,
            row.call.label,
            row.call.agent,
            row.statusLabel,
          ),
        )
        .map(taskRowOf),
      ...phase.declaredTasks
        .filter((task) =>
          matchesFilter(
            filter,
            task.label,
            WORKFLOW_TASK_STATUS_LABEL.declared,
          ),
        )
        .map(declaredRowOf),
    ];
  }

  const attention: WorkflowTaskRow[] = [];
  const queued: WorkflowTaskRow[] = [];
  const done: WorkflowTaskRow[] = [];
  for (const row of phase.tasks) {
    const status = row.call.status;
    if (isAttentionStatus(status)) attention.push(row);
    else if (QUEUED_STATUSES.has(status)) queued.push(row);
    else done.push(row);
  }
  // Stable within a rank: `toSorted` keeps transcript order for equal keys.
  const attentionRows = attention
    .toSorted(
      (a, b) =>
        ATTENTION_RANK[a.call.status as AttentionStatus] -
        ATTENTION_RANK[b.call.status as AttentionStatus],
    )
    .map(taskRowOf);
  const groupRows = (
    group: WorkflowRowGroup,
    members: readonly WorkflowPhaseRow[],
  ): readonly WorkflowPhaseRow[] => {
    if (members.length === 0) return [];
    const expanded = view.expanded.has(group);
    const header: WorkflowPhaseRow = {
      kind: 'group',
      key: `group:${group}`,
      group,
      count: members.length,
      expanded,
    };
    return expanded ? [header, ...members] : [header];
  };
  return [
    ...attentionRows,
    ...groupRows('queued', queued.map(taskRowOf)),
    ...groupRows('done', done.map(taskRowOf)),
    ...groupRows('declared', phase.declaredTasks.map(declaredRowOf)),
  ];
}
