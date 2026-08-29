import {
  isTerminalWorkflowCallProgress,
  WORKFLOW_TASK_STATUS_LABEL,
  type TaskGroup,
  type WorkflowCallKind,
  type WorkflowCallProgress,
} from '@shared/schemas';
import { filterNotNullish } from '@utils/core';
import { formatCompactDuration, formatCostUsd } from '@utils/text/stringUtils';

/** Result-contract label of one issued call, shared by every host. */
const WORKFLOW_CALL_KIND_LABEL = {
  document: 'Document',
  structured: 'Structured',
} as const satisfies Record<WorkflowCallKind, string>;

const CALL_FILE_PREVIEW_LIMIT = 3;

/**
 * The files one issued call was handed, as a single clause: the editable
 * inputs by name (bounded), then how many read-only context/media files ride
 * along. Empty for a declared plan label and for a structured call, which by
 * contract carries no files.
 */
function formatWorkflowCallFiles(
  files: WorkflowCallProgress['files'],
): string | undefined {
  if (!files) return undefined;
  const visible = files.input.slice(0, CALL_FILE_PREVIEW_LIMIT);
  const hiddenInputs = files.input.length - visible.length;
  const parts = [
    visible.length > 0
      ? `${visible.join(', ')}${hiddenInputs > 0 ? ` +${hiddenInputs}` : ''}`
      : undefined,
    files.context.length > 0 ? `${files.context.length} context` : undefined,
    files.media.length > 0 ? `${files.media.length} media` : undefined,
  ].filter(filterNotNullish);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Canonical metadata copy for workflow-call progress on every host: what the
 * call is (kind · agent · model · files) as soon as the script issues it, and
 * what it cost (duration · spend) once it settles. A declared plan label has
 * neither, so its row stays a bare label.
 */
export function formatWorkflowCallMetadataParts(
  call: WorkflowCallProgress,
): string[] {
  const terminal =
    call.status === 'completed' ||
    call.status === 'failed' ||
    call.status === 'cancelled' ||
    (call.status === 'skipped' && call.reason === 'user');
  return [
    call.kind === undefined ? undefined : WORKFLOW_CALL_KIND_LABEL[call.kind],
    call.agent,
    call.model,
    call.attemptNumber === undefined
      ? undefined
      : `attempt ${call.attemptNumber}`,
    formatWorkflowCallFiles(call.files),
    terminal && call.durationMs !== undefined
      ? formatCompactDuration(call.durationMs)
      : undefined,
    terminal && call.totalCostUsd !== undefined
      ? formatCostUsd(call.totalCostUsd)
      : undefined,
  ].filter(filterNotNullish);
}

/**
 * Completion fold for a caller-selected list of calls — `done/total · N
 * running · N failed` — shared by every host so the terminal and the
 * progress view can never disagree on what a phase, or a whole run, has
 * done. The caller selects the calls (each host already holds them in its
 * own container, and matching them here would duplicate that ownership), so
 * the same helper serves both a phase-scoped fold and a whole-run fold from
 * two different call lists.
 *
 * Cancelled calls remain distinct from failures and do not contribute to
 * `failed`. Snapshot consumers (`/executions`) derive their own per-status
 * tallies with `deriveWorkflowCounts` and do not need this helper.
 */
export function workflowCallTally(calls: readonly WorkflowCallProgress[]): {
  readonly done: number;
  readonly total: number;
  readonly running: number;
  readonly failed: number;
} {
  return {
    done: calls.filter((call) => isTerminalWorkflowCallProgress(call)).length,
    total: calls.length,
    running: calls.filter((call) => call.status === 'running').length,
    failed: calls.filter((call) => call.status === 'failed').length,
  };
}

/**
 * Scope a caller-selected list of workflow-task rows to the newest resume
 * attempt, shared by every host's live tally and row selection. A relaunch
 * under the same `meta.name` appends a second projection attempt to the same
 * deterministic transcript with fresh card ids, so without this, dashboards
 * and boards fold every attempt together — doubling totals and keeping stale
 * failures the resume is actively re-running.
 *
 * "Newest" is the last attempt id observed while scanning `entries` in the
 * caller's own (transcript) order, since a resume's cards are appended after
 * the attempt they supersede. Entries with no attempt id (older, pre-attempt
 * transcripts) are never filtered out — only a defined id that disagrees
 * with the newest one drops a row.
 */
export function latestWorkflowAttemptEntries<T>(
  entries: readonly T[],
  attemptIdOf: (entry: T) => string | undefined,
): readonly T[] {
  let latestAttemptId: string | undefined;
  for (const entry of entries) {
    const attemptId = attemptIdOf(entry);
    if (attemptId !== undefined) latestAttemptId = attemptId;
  }
  if (latestAttemptId === undefined) return entries;
  return entries.filter((entry) => {
    const attemptId = attemptIdOf(entry);
    return attemptId === undefined || attemptId === latestAttemptId;
  });
}

/** One workflow phase as its emitter names and orders it. */
export interface WorkflowPhaseHeading {
  readonly phaseLabel: string;
  /** 0-based phase order within the run, when the emitter provides it. */
  readonly phaseIndex?: number;
  /** Total phase count for the run, when the emitter provides it. */
  readonly phaseTotal?: number;
}

/**
 * One phase task group's heading facts, under the names the heading copy uses.
 * Both hosts hold a phase as a `TaskGroup` — the board's group tree and the
 * terminal's dashboard — so the field mapping is stated once here rather than
 * inlined at each call to `formatWorkflowPhaseHeading`.
 */
export function workflowPhaseHeadingOfGroup(
  group: Pick<TaskGroup, 'name' | 'index' | 'total'>,
): WorkflowPhaseHeading {
  return {
    phaseLabel: group.name,
    ...(group.index !== undefined ? { phaseIndex: group.index } : {}),
    ...(group.total !== undefined ? { phaseTotal: group.total } : {}),
  };
}

/**
 * Canonical heading copy for one workflow phase, shared by every surface that
 * names a phase: the transcript's `◆` divider, the live run-status band, the
 * status bar's stage slot, and the focused run's child-list group headers. The
 * leading glyph is left to the caller — the band deliberately carries none.
 * The index is 0-based on the wire and 1-based in the copy.
 *
 * `Reduce (2/3)` with a position and a planned total, `Reduce (2)` with only a
 * position — a phase appended after the declared list keeps its position rather
 * than losing it — and the bare label for a dynamically opened phase.
 */
export function formatWorkflowPhaseHeading(
  phase: WorkflowPhaseHeading,
): string {
  if (phase.phaseIndex === undefined) return phase.phaseLabel;
  const total = phase.phaseTotal !== undefined ? `/${phase.phaseTotal}` : '';
  return `${phase.phaseLabel} (${phase.phaseIndex + 1}${total})`;
}

/**
 * What a run that ended first says about a call, written once here because two
 * channels report it: the execution snapshot the engine terminalizes and the
 * trace cards the run's progress projection settles. Two spellings of one
 * sentence is drift, not two facts.
 */
const WORKFLOW_CALL_NOT_REACHED_NOTE =
  'The workflow ended before this call was reached.';
export const WORKFLOW_CALL_UNFINISHED_NOTE =
  'The workflow ended before this call completed.';

/**
 * The one explanatory-clause rule for a workflow call, shared by every host: a
 * failure reports its error, and a call the run never reached says so. A user
 * skip is self-explanatory and gets no clause.
 */
export function workflowCallDetail(
  call: WorkflowCallProgress,
): { readonly kind: 'error' | 'note'; readonly text: string } | undefined {
  if (call.status === 'failed') return { kind: 'error', text: call.error };
  if (call.status === 'skipped' && call.reason === 'not-reached') {
    return { kind: 'note', text: WORKFLOW_CALL_NOT_REACHED_NOTE };
  }
  return undefined;
}

/**
 * Canonical plain-text projection for workflow-call progress on every host.
 */
export function formatWorkflowCallLine(call: WorkflowCallProgress): string {
  const metadata = formatWorkflowCallMetadataParts(call);
  const suffix = metadata.length > 0 ? ` · ${metadata.join(' · ')}` : '';
  const detail = workflowCallDetail(call);
  const explanation = detail ? ` — ${detail.text}` : '';
  return `${WORKFLOW_TASK_STATUS_LABEL[call.status]}: ${call.label}${suffix}${explanation}`;
}

/**
 * One glyph per call status — the vocabulary every host paints, so a strip
 * of cells reads the same on the terminal and on the board, and reads
 * without colour: pending and running, done and failed, skipped and cached
 * are all distinct shapes.
 */
export const WORKFLOW_CALL_STATUS_GLYPH = {
  declared: '□',
  planned: '□',
  queued: '□',
  running: '☐',
  completed: '☑',
  cached: '✓',
  skipped: '⊘',
  cancelled: '⊘',
  failed: '✗',
} as const satisfies Record<WorkflowCallProgress['status'], string>;

/** Generated-token marker, prefixed to a compact token count (`↓1.2k`)
 *  wherever a host shows what a run has produced so far. */
export const TOKENS_GENERATED = '↓';

/** A phase the run has opened, and its hollow twin for one it has only
 *  declared. */
export const WORKFLOW_PHASE_GLYPH = { opened: '◆', declared: '◇' } as const;

interface WorkflowTallyCounts {
  readonly done: number;
  readonly total: number;
  readonly running: number;
  readonly failed: number;
  readonly declared?: number;
}

/** `done/total · N running · N failed` — the one spelling of a tally. */
export function formatWorkflowTally(tally: WorkflowTallyCounts): string {
  return [
    `${tally.done}/${tally.total}`,
    tally.running > 0 ? `${tally.running} running` : undefined,
    tally.failed > 0 ? `${tally.failed} failed` : undefined,
  ]
    .filter(filterNotNullish)
    .join(' · ');
}

/** A phase's tally: an opened phase counts its calls and, while the plan
 *  still holds tasks it has not issued, how many; a phase known only from the
 *  plan has no calls to count, so its declared count is the whole story. */
export function formatWorkflowPhaseTally(phase: {
  readonly opened: boolean;
  readonly tally: WorkflowTallyCounts;
}): string {
  const declared = phase.tally.declared ?? 0;
  const declaredText = declared > 0 ? `${declared} declared` : undefined;
  if (!phase.opened) return declaredText ?? 'declared';
  return [formatWorkflowTally(phase.tally), declaredText]
    .filter(filterNotNullish)
    .join(' · ');
}
