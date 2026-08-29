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
  isTerminalWorkflowCallProgress,
  type StreamLogEntry,
  type StreamTabId,
  type TaskGroup,
  type WorkflowCallIdentity,
  type WorkflowCallProgress,
  type WorkflowDeclaredPlan,
  type WorkflowPlanMarker,
} from '@shared/schemas';
import type { TranscriptRow, WorkflowTaskRow } from '@shared/transcript';
import {
  TOKENS_GENERATED,
  workflowPhaseHeadingOfGroup,
  type WorkflowPhaseHeading,
  type WorkflowTally,
} from '@shared/copy/workflowCall';
import { filterNotNullish, formatCompactTokenCount } from '@utils/core';
import {
  formatCompactDuration,
  formatCostUsd,
  pluralize,
} from '@utils/text/stringUtils';

// ---------------------------------------------------------------------------
// Markers on the transcript
// ---------------------------------------------------------------------------

/** What an `INTERNAL` transcript entry says about the workflow run. */
type WorkflowMarker =
  | { readonly kind: 'plan'; readonly plan: WorkflowPlanMarker }
  | { readonly kind: 'malformedPlan'; readonly error: string };

function internalMarkerKind(data: unknown): unknown {
  return typeof data === 'object' && data !== null
    ? (data as { readonly kind?: unknown }).kind
    : undefined;
}

/**
 * Read the workflow marker one transcript entry carries, if any. Every host
 * folds these the same way: the newest plan marker is the live plan (a
 * relaunch under the same `meta.name` appends its own after the one it
 * supersedes, and every attempt that reaches the engine records exactly one),
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
  if (internalMarkerKind(entry.data) !== 'workflowPlan') return undefined;
  const parsed = WorkflowPlanMarkerSchema.safeParse(entry.data);
  return parsed.success
    ? { kind: 'plan', plan: parsed.data }
    : { kind: 'malformedPlan', error: parsed.error.message };
}

// ---------------------------------------------------------------------------
// The run model
// ---------------------------------------------------------------------------

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
  /** A card's child run progress, by row id, where the card has a child
   *  stream of its own (`childStreamOf`) and the host holds that stream. */
  readonly liveOf: ReadonlyMap<string, ChildRunProgress>;
}

/**
 * What a child run reports about itself while it runs, read off the child's
 * own stream by whichever host holds it — the one owner of these facts — and
 * joined to the card that opened the child by the model (`liveOf`). Elapsed
 * origin and tool calls come from stream state on every host; tokens and
 * spend only where a host projects usage per stream.
 */
export interface ChildRunProgress {
  readonly runStartedAt?: number;
  readonly toolCallCount: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

interface WorkflowRunModelInput {
  readonly taskGroups: readonly TaskGroup[];
  /** The stream's rows; the model picks the `workflowTask` ones. */
  readonly rows: readonly TranscriptRow[];
  /** The newest attempt's declared plan, if the transcript recorded one. */
  readonly plan: WorkflowDeclaredPlan | undefined;
  /** True once the run has ended: plan-only phases it never reached are then
   *  nothing to show (the projection's settle sweep has housed every declared
   *  card under a stage, so an empty plan-only phase is its own
   *  skipped-empty-phase suppression). */
  readonly runSettled: boolean;
  /** Live progress by child stream, for the cards that opened those streams. */
  readonly childProgress: ReadonlyMap<StreamTabId, ChildRunProgress>;
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
  return {
    done: tasks.filter((row) => isTerminalWorkflowCallProgress(row.call))
      .length,
    total: tasks.length,
    running: tasks.filter((row) => row.call.status === 'running').length,
    failed: tasks.filter((row) => row.call.status === 'failed').length,
    declared,
  };
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
  plan: WorkflowDeclaredPlan,
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
  for (const [index, declared] of plan.phases.entries()) {
    const declaredTasks = declaredByPhase.get(declared.title) ?? [];
    let phase = byTitle.get(declared.title);
    if (!phase) {
      if (runSettled && declaredTasks.length === 0) continue;
      phase = {
        key: `declared-${declared.title}`,
        heading: {
          phaseLabel: declared.title,
          phaseIndex: index,
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
  // "Newest" is the last attempt id in transcript order — a resume's cards
  // are appended after the attempt they supersede. A card with no attempt id
  // (an older transcript) is never dropped; only a defined id that disagrees
  // with the newest one is.
  let latestAttemptId: string | undefined;
  for (const row of cards)
    latestAttemptId = row.call.attemptId ?? latestAttemptId;
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
    const attemptId = row.call.attemptId;
    if (attemptId !== undefined && attemptId !== latestAttemptId) {
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
  const liveOf = new Map<string, ChildRunProgress>();
  for (const [childStreamId, row] of claimants) {
    if (!row) continue;
    childStreamOf.set(row.id, childStreamId);
    const progress = input.childProgress.get(childStreamId);
    if (progress) liveOf.set(row.id, progress);
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
    liveOf,
  };
}

/**
 * The in-flight segments a card cannot carry itself — elapsed, generated
 * tokens, running spend, tool calls — from the child run's own progress.
 * Elapsed and spend show only while the call is live (a settled card carries
 * its own duration and cost); tokens and tool calls stay, since nothing else
 * records them. Elapsed needs a clock: a host without one passes no `nowMs`
 * and shows the rest.
 */
export function formatWorkflowCallLiveParts(
  call: WorkflowCallProgress,
  live: ChildRunProgress | undefined,
  nowMs?: number,
): string[] {
  if (!live) return [];
  const settled = isTerminalWorkflowCallProgress(call);
  return [
    !settled && live.runStartedAt !== undefined && nowMs !== undefined
      ? formatCompactDuration(nowMs - live.runStartedAt)
      : undefined,
    live.outputTokens !== undefined && live.outputTokens > 0
      ? `${TOKENS_GENERATED}${formatCompactTokenCount(live.outputTokens)}`
      : undefined,
    !settled && live.costUsd !== undefined && live.costUsd > 0
      ? formatCostUsd(live.costUsd)
      : undefined,
    live.toolCallCount > 0
      ? `${live.toolCallCount} ${pluralize(live.toolCallCount, 'tool')}`
      : undefined,
  ].filter(filterNotNullish);
}

// ---------------------------------------------------------------------------
// A phase's rows: attention first, volume collapsed
// ---------------------------------------------------------------------------

/** The counted groups a phase's quiet rows collapse into. */
export type WorkflowRowGroup = 'queued' | 'declared';

const WORKFLOW_ROW_GROUP_LABEL = {
  queued: 'queued',
  declared: 'declared',
} as const satisfies Record<WorkflowRowGroup, string>;

/** `12 queued` — the one spelling of a counted group's row. */
export function formatWorkflowRowGroup(row: {
  readonly count: number;
  readonly group: WorkflowRowGroup;
}): string {
  return `${row.count} ${WORKFLOW_ROW_GROUP_LABEL[row.group]}`;
}

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

/** Rows that failed lead, rows worth watching follow. */
const ATTENTION_STATUSES = ['failed', 'running'] as const;
type AttentionStatus = (typeof ATTENTION_STATUSES)[number];
const ATTENTION_RANK: Record<AttentionStatus, number> = {
  failed: 0,
  running: 1,
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
 * without one, cards needing attention (failed, then running — transcript
 * order within) lead, finished cards follow as rows of their own (a ticked
 * box is the record of what ran), and the cards that have not started
 * collapse into `queued` / `declared` groups that open in place.
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
    ...done.map(taskRowOf),
    ...groupRows('queued', queued.map(taskRowOf)),
    ...groupRows('declared', phase.declaredTasks.map(declaredRowOf)),
  ];
}
