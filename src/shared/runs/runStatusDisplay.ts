import {
  RUN_PHASE,
  RUN_LIFECYCLE_READY,
  RUN_SUBSTATE,
  type RoundStage,
  type RunFlow,
  type RunLifecycleStatus,
  type RunSubstate,
} from '@shared/schemas';
import type { RunGroup } from '@shared/session/sessionView';

export type RunStatusDisplayKey =
  | Exclude<RunLifecycleStatus, typeof RUN_LIFECYCLE_READY>
  | RunSubstate
  | 'ready';

/**
 * The fold's interrupted reading (PRD one-fold-three-renderers, 5.2): an
 * in-flight run whose owner process nobody holds. A copy key over the
 * durable phase, never a lifecycle status or a host display key, so the
 * durable event set and the hosts' per-status tables stay what they are and
 * only the label and tone change.
 */
const RUN_DISPLAY_INTERRUPTED = 'interrupted';
type RunStatusCopyKey = RunStatusDisplayKey | typeof RUN_DISPLAY_INTERRUPTED;

/**
 * Display key for a `RunLifecycleStatus` (a `RunPhase`, or the `ready`
 * idle sentinel every host defaults an unstarted run to).
 */
export function runStatusDisplayKey(
  status: RunLifecycleStatus,
  substate?: RunSubstate,
): RunStatusDisplayKey {
  if (status === RUN_LIFECYCLE_READY) return 'ready';
  return substate ?? status;
}

/**
 * The one status label table (PRD one-fold-three-renderers, G4): the fold
 * reads it into `RunView.statusLabel`, and every renderer prints that
 * word as is. `packages/cli/scripts/validate-run.mjs` pins the completed and
 * stopped words from here against the real headless run.
 */
const RUN_STATUS_LABELS: Record<RunStatusCopyKey, string> = {
  [RUN_SUBSTATE.STARTING]: 'Initializing',
  [RUN_PHASE.RUNNING]: 'Running',
  [RUN_PHASE.FAILED]: 'Error',
  [RUN_PHASE.COMPLETED]: 'Completed',
  [RUN_PHASE.CANCELLED]: 'Stopped',
  ready: 'Ready',
  [RUN_PHASE.WAITING]: 'Idle',
  [RUN_SUBSTATE.RESUMING]: 'Resuming',
  [RUN_DISPLAY_INTERRUPTED]: 'Interrupted',
};

/**
 * The one status-to-tone mapping (PRD one-fold-three-renderers, G4 and 15):
 * a fact-only word every host paints in its own colour vocabulary. Keyed by
 * the same display key as the labels above, so a status that gains a label
 * must gain a tone in the same edit.
 */
export const RUN_STATUS_TONE = {
  RUNNING: 'running',
  SUCCESS: 'success',
  DANGER: 'danger',
  NEUTRAL: 'neutral',
  WARNING: 'warning',
} as const;
type RunStatusTone = (typeof RUN_STATUS_TONE)[keyof typeof RUN_STATUS_TONE];

const RUN_STATUS_TONES: Record<RunStatusCopyKey, RunStatusTone> = {
  [RUN_SUBSTATE.STARTING]: RUN_STATUS_TONE.RUNNING,
  [RUN_PHASE.RUNNING]: RUN_STATUS_TONE.RUNNING,
  [RUN_PHASE.FAILED]: RUN_STATUS_TONE.DANGER,
  [RUN_PHASE.COMPLETED]: RUN_STATUS_TONE.SUCCESS,
  [RUN_PHASE.CANCELLED]: RUN_STATUS_TONE.NEUTRAL,
  ready: RUN_STATUS_TONE.NEUTRAL,
  [RUN_PHASE.WAITING]: RUN_STATUS_TONE.NEUTRAL,
  [RUN_SUBSTATE.RESUMING]: RUN_STATUS_TONE.RUNNING,
  [RUN_DISPLAY_INTERRUPTED]: RUN_STATUS_TONE.WARNING,
};

/**
 * The label and tone pair a `RunView` carries (G4), read from the one
 * table through one display key: the status and substate, or the fold's
 * interrupted reading when an in-flight run has lost its owner.
 */
export function runStatusCopy(
  status: RunLifecycleStatus,
  options: {
    readonly substate?: RunSubstate;
    readonly interrupted?: boolean;
  } = {},
): { readonly statusLabel: string; readonly tone: RunStatusTone } {
  const key = options.interrupted
    ? RUN_DISPLAY_INTERRUPTED
    : runStatusDisplayKey(status, options.substate);
  return {
    statusLabel: RUN_STATUS_LABELS[key],
    tone: RUN_STATUS_TONES[key],
  };
}

/** Banner copy for the fold's interrupted reading: the process running the
 *  run is gone; a pending approval stays listed, so a resume re-asks it. */
export function runInterruptedMessage(): string {
  return 'The process running this run stopped before it finished. Resume it to continue.';
}

/** Banner and tooltip copy for a run another TeXRA process holds, named by
 *  its pid: the one part of a process identity a user can act on. */
export function runHeldMessage(pid: number): string {
  return `Held by another TeXRA process (pid ${pid}). Let it finish or close it; if it is gone, Delete removes the run.`;
}

/** Banner and tooltip copy for a run whose saved state could not be read. */
export function runUnreadableMessage(cause: string): string {
  return `Could not read this run's state: ${cause}. Delete removes it.`;
}

export function formatRunStatusLabel(status: RunLifecycleStatus): string {
  return RUN_STATUS_LABELS[runStatusDisplayKey(status)];
}

/** Compact round/turn progress label: `r2/3` when the planned total is known
 *  (workflow runs), else `r2`. Zero-based `index` renders one-based. */
export function formatRoundStageLabel(stage: Readonly<RoundStage>): string;

export function formatRoundStageLabel(
  stage: Readonly<RoundStage> | undefined,
): string | undefined;

export function formatRoundStageLabel(
  stage: Readonly<RoundStage> | undefined,
): string | undefined {
  if (stage === undefined) return undefined;
  const current = `r${stage.index + 1}`;
  return stage.total !== undefined ? `${current}/${stage.total}` : current;
}

/** Where a run's loop stands, in the coordinate its family counts in. */
export interface FlowPosition {
  readonly kind: 'round' | 'turn';
  readonly index: number;
}

/**
 * The coordinate a run's family counts its position in: a reflection run
 * advances `round`, a tool-use run advances `turn` and leaves `round` at the
 * zero it opened with. A renderer that reads `round` first therefore paints
 * `r1` over every tool-use run for its whole life, which is why this rule has
 * one home rather than one copy per surface. The two coordinates are not
 * counted alike on the row: `round` is zero-based (a reflection flow opens at
 * round 0), while `turn` is already one-based — the tool-use loop commits
 * `state.turn + 1` from a zero start and the child loop counts its first turn
 * as 1 — so only `round` gains one when it renders.
 */
export function flowPosition(
  flow: RunFlow | null | undefined,
): FlowPosition | undefined {
  if (flow == null) return undefined;
  if (flow.family === 'reflection') {
    return flow.round == null
      ? undefined
      : { kind: 'round', index: flow.round };
  }
  return flow.turn == null ? undefined : { kind: 'turn', index: flow.turn };
}

/** Compact position label: `r2` (or `r2/3` against a planned round total) for
 *  a round, `t2` for the row's second turn. A total counts planned rounds, so
 *  a turn ignores it. */
export function formatFlowPositionLabel(
  position: Readonly<FlowPosition>,
  total?: number,
): string;

export function formatFlowPositionLabel(
  position: Readonly<FlowPosition> | undefined,
  total?: number,
): string | undefined;

export function formatFlowPositionLabel(
  position: Readonly<FlowPosition> | undefined,
  total?: number,
): string | undefined {
  if (position === undefined) return undefined;
  if (position.kind === 'turn') return `t${position.index}`;
  return formatRoundStageLabel({
    index: position.index,
    ...(total !== undefined ? { total } : {}),
  });
}

/** Spelled-out counterpart of {@link formatFlowPositionLabel} on the same
 *  family-selected coordinate — `Round 2`, `Turn 2` — for the surfaces that
 *  word the position instead of abbreviating it. Only `round` gains one, for
 *  the reason {@link flowPosition} states. */
export function formatFlowPositionTitle(
  position: Readonly<FlowPosition> | undefined,
): string | undefined {
  if (position === undefined) return undefined;
  return position.kind === 'round'
    ? `Round ${position.index + 1}`
    : `Turn ${position.index}`;
}

/**
 * One section per `group` arm, and the order the sections are painted in.
 * Both surfaces that group a run list — the webview tab strip and the
 * TUI's run tree — read this table rather than spelling the four labels
 * again, so a renamed section cannot say one thing in the dock and another
 * in the terminal.
 *
 * Deep-frozen: the record crosses a module boundary into two renderers, and
 * `readonly` is compile-time only.
 */
export const RUN_GROUP_LABELS: Readonly<Record<RunGroup, string>> =
  Object.freeze({
    running: 'Running',
    waiting: 'Waiting on you',
    interrupted: 'Interrupted',
    recent: 'Recent',
  });

/** Section order, in the group union's own order. */
export const RUN_GROUP_ORDER: readonly RunGroup[] = Object.freeze(
  Object.keys(RUN_GROUP_LABELS) as RunGroup[],
);
