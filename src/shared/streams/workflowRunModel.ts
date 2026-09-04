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
  WORKFLOW_CALL_STATUS,
  WORKFLOW_TASK_STATUS_LABEL,
  WorkflowPlanMarkerSchema,
  interruptedWorkflowCall,
  isTerminalWorkflowCallProgress,
  isTerminalWorkflowCallStatus,
  type StreamLifecycleStatus,
  type StreamLogEntry,
  type StreamTabId,
  type TaskGroup,
  type WorkflowCallIdentity,
  type WorkflowCallProgress,
  type WorkflowDeclaredPlan,
  type WorkflowPlanMarker,
} from '@shared/schemas';
import type { TranscriptRow, WorkflowTaskRow } from '@shared/transcript';
import { compareBySeqNo, usableSequence } from '@shared/streams/streamOrdering';
import { workflowRunSettled } from '@shared/streams/streamStatus';
import {
  TOKENS_GENERATED,
  formatWorkflowCallLine,
  formatWorkflowCallMetadataParts,
  workflowCallDetail,
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
  | {
      readonly kind: 'plan';
      readonly attemptId: string;
      readonly plan: WorkflowPlanMarker;
    }
  | {
      readonly kind: 'malformedPlan';
      readonly attemptId?: string;
      readonly error: string;
    };

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
  if (parsed.success) {
    return {
      kind: 'plan',
      attemptId: parsed.data.attemptId,
      plan: parsed.data,
    };
  }
  // Recover only the attempt boundary. The plan body remains unknown unless
  // the full strict marker schema succeeds, so malformed phases/tasks never
  // enter declared-plan rendering while a valid id still scopes stale rows.
  const attemptId = WorkflowPlanMarkerSchema.shape.attemptId.safeParse(
    (entry.data as { readonly attemptId?: unknown }).attemptId,
  );
  return {
    kind: 'malformedPlan',
    ...(attemptId.success ? { attemptId: attemptId.data } : {}),
    error: parsed.error.message,
  };
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
  /** Current-attempt cards issued outside a phase, when any. */
  readonly unphasedPhase: WorkflowPhaseModel | undefined;
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
  /** The newest attempt boundary recovered from its transcript marker, even
   *  when that marker's declared-plan body is malformed. */
  readonly workflowAttemptId?: string;
  /** The newest attempt's declared plan, if the transcript recorded a valid one. */
  readonly plan: WorkflowDeclaredPlan | WorkflowPlanMarker | undefined;
  /** The stream's resolved lifecycle phase. The run has ended once it is
   *  neither running nor waiting (`workflowRunSettled`), and plan-only phases
   *  it never reached are then nothing to show — the projection's settle
   *  sweep has housed every declared card under a stage, so an empty
   *  plan-only phase is its own skipped-empty-phase suppression. */
  readonly streamPhase: StreamLifecycleStatus | undefined;
  /** Whether the run is durably final: a terminal outcome with no producer
   *  left anywhere (the fold's `runDurablyFinal`) — the same fact
   *  `taskGroupDisplayStatus` reads for an unclosed task group, as the bit
   *  alone, since an unsettled card is repainted with the producer's own
   *  interrupted vocabulary rather than with the run's outcome. A terminal
   *  phase alone will not do: a user stop publishes CANCELLED while the run
   *  is still unwinding in this process and its cards are still being
   *  settled, and a foreign-owned run has ended here without ending at all. */
  readonly runDurablyFinal: boolean;
  /** Live progress by child stream, for the cards that opened those streams. */
  readonly childProgress: ReadonlyMap<StreamTabId, ChildRunProgress>;
}

interface MutablePhase {
  readonly key: string;
  readonly heading: WorkflowPhaseHeading;
  readonly tasks: WorkflowTaskRow[];
  readonly opened: boolean;
  readonly attemptId?: string;
  declaredTasks: readonly WorkflowCallIdentity[];
}

function compareCardFallback(
  left: WorkflowTaskRow,
  right: WorkflowTaskRow,
): number {
  return left.timestamp - right.timestamp;
}

/**
 * Cards in deterministic transcript order, even when a caller collected a
 * group tree pre-order. Sequence and legacy rows are each ordered by their
 * own chronology, then kept as generation blocks ordered by their newest
 * facts. No causal key exists between generations, so this cannot recover an
 * interleaving across clock skew, but unlike a pairwise seq/time fallback it
 * is transitive and independent of input tree order except for truly
 * indistinguishable equal-time legacy facts, whose stable input order remains
 * the compatibility tie-break.
 */
function workflowCardsInTranscriptOrder(
  rows: readonly TranscriptRow[],
): WorkflowTaskRow[] {
  const sequenced: WorkflowTaskRow[] = [];
  const legacy: WorkflowTaskRow[] = [];
  for (const row of rows) {
    if (row.kind !== 'workflowTask') continue;
    (usableSequence(row.seqNo) === undefined ? legacy : sequenced).push(row);
  }
  sequenced.sort((left, right) =>
    compareBySeqNo(
      left,
      right,
      (row) => row.seqNo,
      (row) => row.timestamp,
    ),
  );
  legacy.sort(compareCardFallback);
  if (sequenced.length === 0) return legacy;
  if (legacy.length === 0) return sequenced;
  return compareCardFallback(sequenced.at(-1)!, legacy.at(-1)!) <= 0
    ? [...sequenced, ...legacy]
    : [...legacy, ...sequenced];
}

interface AttemptBoundary {
  readonly attemptId: string;
  readonly timestamp: number;
  readonly stableKey: string;
  readonly seqNo?: number;
}

function laterAttemptBoundaryByTime(
  left: AttemptBoundary | undefined,
  right: AttemptBoundary,
): AttemptBoundary {
  if (!left) return right;
  if (right.timestamp !== left.timestamp) {
    return right.timestamp > left.timestamp ? right : left;
  }
  return right.stableKey > left.stableKey ? right : left;
}

/**
 * One run-wide attempt identity, selected before any phase is tallied.
 * Sequenced cards first elect their newest wire fact without consulting wall
 * clocks. Legacy cards and phase boundaries elect by time with a stable key;
 * the two generation winners then use that same fallback chronology. There is
 * no causal key that can order a legacy fact against a sequenced one, so clock
 * skew across that boundary remains inherently ambiguous, but this staged fold
 * is deterministic and cannot form the mixed-comparator cycles a sort can.
 */
function latestWorkflowAttemptId(
  cards: readonly WorkflowTaskRow[],
  taskGroups: readonly TaskGroup[],
  plan: WorkflowRunModelInput['plan'],
  markerAttemptId: string | undefined,
): string | undefined {
  if (markerAttemptId !== undefined) return markerAttemptId;
  if (plan && 'attemptId' in plan) return plan.attemptId;

  let sequenced: AttemptBoundary | undefined;
  let fallback: AttemptBoundary | undefined;
  for (const row of cards) {
    const attemptId = row.call.attemptId;
    if (attemptId === undefined) continue;
    const seqNo = usableSequence(row.seqNo);
    const boundary: AttemptBoundary = {
      attemptId,
      timestamp: row.timestamp,
      stableKey: `card:${row.id}`,
      ...(seqNo !== undefined ? { seqNo } : {}),
    };
    if (seqNo === undefined) {
      fallback = laterAttemptBoundaryByTime(fallback, boundary);
    } else {
      const previousSeqNo = sequenced?.seqNo;
      if (
        previousSeqNo === undefined ||
        seqNo > previousSeqNo ||
        (seqNo === previousSeqNo &&
          laterAttemptBoundaryByTime(sequenced, boundary) === boundary)
      ) {
        sequenced = boundary;
      }
    }
  }
  for (const group of taskGroups) {
    if (group.kind !== 'phase' || group.attemptId === undefined) continue;
    fallback = laterAttemptBoundaryByTime(fallback, {
      attemptId: group.attemptId,
      timestamp: group.startTime,
      stableKey: `phase:${group.id}`,
    });
  }

  if (!fallback) return sequenced?.attemptId;
  if (!sequenced) return fallback.attemptId;
  return laterAttemptBoundaryByTime(sequenced, fallback).attemptId;
}

/**
 * One unsettled card as a run nothing can still settle leaves it, in the
 * producer's own vocabulary: `interruptedWorkflowCall` is the same function
 * `StreamLogStore.endRunningGroupsForStreams` settles the persisted row with,
 * so a card repainted here and one the write side already settled read
 * identically — a launched call as `failed` with the one interrupted-call
 * error, an unlaunched one as `skipped`/`not-reached`.
 *
 * The status and every piece of copy derived from it are re-read through the
 * shared formatters, so the card, its status word, its explanatory line, the
 * phase strip and the tally are one reading rather than five. A card its
 * producer already settled is returned untouched.
 */
function interruptedTaskRow(row: WorkflowTaskRow): WorkflowTaskRow {
  if (isTerminalWorkflowCallProgress(row.call)) return row;
  const call: WorkflowCallProgress = interruptedWorkflowCall(row.call);
  const detail = workflowCallDetail(call);
  return {
    ...row,
    call,
    line: formatWorkflowCallLine(call),
    statusLabel: WORKFLOW_TASK_STATUS_LABEL[call.status],
    metadataParts: formatWorkflowCallMetadataParts(call),
    ...(detail ? { detail } : {}),
  };
}

function phaseLogicalIdentity(phase: MutablePhase): string {
  return `${phase.heading.phaseLabel}\u0000${phase.heading.phaseIndex ?? 'unknown'}`;
}

/** Counts over the statuses the cells PAINT, so a tally can never say
 *  "1 running" beside a strip that shows the call as cancelled. */
function tallyOf(
  statuses: readonly WorkflowCallProgress['status'][],
  declared: number,
): WorkflowTally {
  return {
    done: statuses.filter(isTerminalWorkflowCallStatus).length,
    total: statuses.length,
    running: statuses.filter(
      (status) => status === WORKFLOW_CALL_STATUS.RUNNING,
    ).length,
    failed: statuses.filter((status) => status === WORKFLOW_CALL_STATUS.FAILED)
      .length,
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
      ...(group.attemptId !== undefined ? { attemptId: group.attemptId } : {}),
      declaredTasks: [],
    };
    phases.push(phase);
    byGroupId.set(group.id, phase);
  }
  // A relaunch under the same meta.name appends a second projection attempt
  // to the same transcript with fresh card ids; scope to the newest attempt
  // so a resume's live rows and totals never fold a superseded attempt's
  // cards in with the one actually running.
  const cards = workflowCardsInTranscriptOrder(input.rows);
  // The latest plan marker is definitive even before the attempt issues a
  // card. Without one, the fallback elects from sequenced cards plus timed
  // legacy cards and phase openings, including calls issued outside a phase.
  const latestAttemptId = latestWorkflowAttemptId(
    cards,
    input.taskGroups,
    input.plan,
    input.workflowAttemptId,
  );
  // Cards predate phase ownership. For an untagged legacy phase that did issue
  // calls, those calls still prove which attempt owned the group; only a
  // genuinely call-less untagged phase remains ambiguous.
  const cardAttemptsByGroupId = new Map<string, Set<string>>();
  for (const row of cards) {
    const groupId = row.groupId;
    const attemptId = row.call.attemptId;
    if (groupId === undefined || attemptId === undefined) continue;
    const attempts = cardAttemptsByGroupId.get(groupId) ?? new Set<string>();
    attempts.add(attemptId);
    cardAttemptsByGroupId.set(groupId, attempts);
  }
  const tasks: WorkflowTaskRow[] = [];
  // A card issued outside any open phase has no group to sit under; it joins
  // one trailing "Unphased" phase rather than vanishing.
  let unphased: MutablePhase | undefined;
  for (const card of cards) {
    const phase = card.groupId ? byGroupId.get(card.groupId) : undefined;
    const attemptId = card.call.attemptId;
    if (latestAttemptId !== undefined && attemptId !== latestAttemptId) {
      continue;
    }
    // The one repaint, made here so both collections hold the same row: a
    // call the run left unsettled with nothing alive to settle it reads as
    // its producer would have settled it, rather than as a call that never
    // stops or one still waiting for a slot that will never come.
    const row = input.runDurablyFinal ? interruptedTaskRow(card) : card;
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
  // Phase ownership handles the call-less case that card references cannot:
  // an explicitly superseded empty phase is stale. Untagged empty phases are
  // preserved for traces written before phase ownership shipped on 2026-08-31
  // unless the latest attempt opened the same title/index, which is the only
  // evidence that the untagged copy is old. Retire this compatibility branch
  // after 2026-11-30, when those pre-ownership traces leave support.
  const latestOwnedPhaseIdentities = new Set(
    phases
      .filter((phase) => phase.attemptId === latestAttemptId)
      .map(phaseLogicalIdentity),
  );
  const opened = phases.filter(
    (phase) =>
      phase.tasks.length > 0 ||
      latestAttemptId === undefined ||
      phase.attemptId === latestAttemptId ||
      (phase.attemptId === undefined &&
        (cardAttemptsByGroupId.get(phase.key)?.has(latestAttemptId) ?? true) &&
        !latestOwnedPhaseIdentities.has(phaseLogicalIdentity(phase))),
  );
  const ordered = [
    ...(input.plan
      ? unionWithDeclaredPlan(
          opened,
          input.plan,
          tasks,
          workflowRunSettled(input.streamPhase),
        )
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
  const phaseModels = ordered.map((phase) => {
    const cells = phase.tasks.map((row) => row.call.status);
    return {
      ...phase,
      tally: tallyOf(cells, phase.declaredTasks.length),
      cells,
    };
  });
  return {
    phases: phaseModels,
    tasks,
    unphasedPhase:
      unphased === undefined
        ? undefined
        : phaseModels[ordered.indexOf(unphased)],
    tally: tallyOf(
      tasks.map((row) => row.call.status),
      declaredTotal,
    ),
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

/** `12 queued` — the one spelling of a counted group's row. */
export function formatWorkflowRowGroup(row: {
  readonly count: number;
  readonly group: WorkflowRowGroup;
}): string {
  return `${row.count} ${row.group}`;
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
type AttentionStatus = 'failed' | 'running';
const ATTENTION_RANK: Record<AttentionStatus, number> = {
  failed: 0,
  running: 1,
};

function isAttentionStatus(
  status: WorkflowCallProgress['status'],
): status is AttentionStatus {
  return status === 'failed' || status === 'running';
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
