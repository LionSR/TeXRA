import { type ScriptTally, type TaskGroup } from '@shared/schemas';
import { filterNotNullish } from '@utils/core';

const CALL_FILE_PREVIEW_LIMIT = 3;

/**
 * The files one issued call was handed, as a single clause: the editable
 * inputs by name (bounded), then how many read-only context/media files ride
 * along; undefined when it was handed none.
 */
export function formatWorkflowCallFiles(files: {
  readonly input: readonly string[];
  readonly context: readonly string[];
  readonly media: readonly string[];
}): string | undefined {
  const visible = files.input.slice(0, CALL_FILE_PREVIEW_LIMIT);
  const hiddenInputs = files.input.length - visible.length;
  const hiddenSuffix = hiddenInputs > 0 ? ` +${hiddenInputs}` : '';
  const parts = [
    visible.length > 0 ? `${visible.join(', ')}${hiddenSuffix}` : undefined,
    files.context.length > 0 ? `${files.context.length} context` : undefined,
    files.media.length > 0 ? `${files.media.length} media` : undefined,
  ].filter(filterNotNullish);
  return parts.length > 0 ? parts.join(' · ') : undefined;
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

/** Generated-token marker, prefixed to a compact token count (`↓1.2k`)
 *  wherever a host shows what a run has produced so far. */
export const TOKENS_GENERATED = '↓';

const WORKFLOW_TALLY_WORDS = [
  ['ok', 'ok'],
  ['running', 'running'],
  ['queued', 'queued'],
  ['planned', 'not started'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
  ['skipped', 'skipped'],
  ['notRun', 'not run'],
] as const satisfies readonly (readonly [keyof ScriptTally, string])[];

/** `6 ok · 1 failed · 1 not run` — the one spelling of a tally, by outcome,
 *  so no count can read as "done" beside a failure it includes. */
export function formatScriptTally(tally: ScriptTally): string {
  const parts = WORKFLOW_TALLY_WORDS.filter(([key]) => tally[key] > 0).map(
    ([key, word]) => `${tally[key]} ${word}`,
  );
  return parts.length > 0 ? parts.join(' · ') : 'no calls';
}
