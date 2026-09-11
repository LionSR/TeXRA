/**
 * The TUI's read of the one session state (PRD one-fold-three-renderers,
 * 10.1): `SessionHandle.view` bridged into a Lit signal, so every Ink
 * component reads the fold with `useSignal(sessionView())` and derives
 * nothing the fold already states.
 *
 * Bound once per chat session by `runChat` from the runtime session's
 * `view`; a component rendered before that is a programming error, not a
 * case to paper over with an empty view.
 */
import { signal, type Signal } from '@lit-labs/signals';
import { SubscriptionRef } from 'effect';
import { effectRuntime } from '@platform/processRuntime';
import {
  AgentCategory,
  isPlainAgentIdentity,
  RUN_LIFECYCLE_READY,
  RUN_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  type RunPhase,
  type RunId,
} from '@shared/schemas';
import { toSignal, type StreamSignal } from '@shared/signals';
import {
  descendantRuns,
  type SessionView,
  type RunView,
} from '@shared/session/sessionView';
import { isInFlightPhase } from '@shared/runs/runStatus';
import { formatPhaseStageLabel } from '@shared/runs/runStatusDisplay';

/** The bound bridge, itself a signal so a computed over the view (the
 *  approval Surface's foreground) re-tracks when a chat session rebinds. */
const bound = signal<StreamSignal<SessionView> | undefined>(undefined);

/**
 * Bridge a session's view level into the TUI's signal; returns the unbind.
 * The only meeting point between Effect and the components (PRD 7.5): the
 * view's change run bridged onto the process runtime by `toSignal`.
 */
export function bindSessionView(
  view: SubscriptionRef.SubscriptionRef<SessionView>,
): () => void {
  bound.get()?.dispose();
  const bridgedBound = toSignal(
    effectRuntime(),
    SubscriptionRef.changes(view),
    SubscriptionRef.getUnsafe(view),
  );
  bound.set(bridgedBound);
  return () => {
    if (bound.get() !== bridgedBound) return;
    bridgedBound.dispose();
    bound.set(undefined);
  };
}

/** The bound view signal. */
export function sessionView(): Signal.State<SessionView> {
  const current = bound.get();
  if (!current) {
    throw new Error(
      'The session view is not bound: call bindSessionView(session.view) before rendering the TUI.',
    );
  }
  return current;
}

/** The current view, read outside a render (keystroke handlers, commands). */
export function currentView(): SessionView {
  return sessionView().get();
}

export function runViewOf(
  view: SessionView,
  runId: RunId | undefined,
): RunView | undefined {
  return runId === undefined ? undefined : view.runs.get(runId);
}

/** The run to stop when a child is still running or waiting. */
export function killableRunId(run: RunView | undefined): RunId | undefined {
  return run &&
    run.parentId !== null &&
    (run.group === 'running' || run.group === 'waiting')
    ? run.id
    : undefined;
}

/** Whether a focused child run takes the composer's follow-ups (PRD 10.1). */
export function focusedChildAcceptsFollowUps(run: RunView): boolean {
  return (
    run.followUpSupport === USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE &&
    isPlainAgentIdentity(run.identity) &&
    run.category === AgentCategory.ToolUse &&
    isInFlightPhase(run.status)
  );
}

/** The name a run goes by on this surface: `main` for a root, the
 *  fold's label below it. */
export function runLabelOf(run: RunView): string {
  return run.parentId === null ? 'main' : run.label;
}

/** The run's phase: undefined before the first `status` folds. */
export function runPhaseOf(run: RunView | undefined): RunPhase | undefined {
  return run === undefined || run.status === RUN_LIFECYCLE_READY
    ? undefined
    : run.status;
}

/**
 * The direct children in the RUNNING phase. The fold's `rollup.running`
 * counts in-flight runs (running or idle-waiting); the TUI's "active"
 * excludes a child parked between turns, so it reads each child's status
 * fact rather than the rollup.
 */
export function runningChildCount(
  view: SessionView,
  run: RunView | undefined,
): number {
  return (run?.childIds ?? []).filter(
    (id) => view.runs.get(id)?.status === RUN_PHASE.RUNNING,
  ).length;
}

/** Whether the root or any run under it is in the RUNNING phase. */
export function anyRunRunning(
  view: SessionView,
  rootRunId: RunId | undefined,
): boolean {
  return descendantRuns(view, rootRunId, { includeRoot: true }).some(
    (id) => view.runs.get(id)?.status === RUN_PHASE.RUNNING,
  );
}

/** The nearest ancestor's workflow-phase heading, for a child's location. */
export function ancestorPhaseLabel(
  view: SessionView,
  runId: RunId,
): string | undefined {
  const ancestors = runViewOf(view, runId)?.ancestors ?? [];
  // Root first in the view; the nearest ancestor's phase wins.
  for (const ancestor of ancestors.toReversed()) {
    const stage = runViewOf(view, ancestor.id)?.stage;
    if (stage?.kind === 'phase') return formatPhaseStageLabel(stage);
  }
  return undefined;
}
