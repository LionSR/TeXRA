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
import { Cause, Stream, SubscriptionRef } from 'effect';
import type { ProcessRuntime } from '@platform/processRuntime';
import {
  RUN_LIFECYCLE_READY,
  RUN_PHASE,
  type RunPhase,
  type RunId,
} from '@shared/schemas';
import { toSignal, type StreamSignal } from '@shared/signals';
import type {
  FollowUpHost,
  SessionView,
  RunView,
} from '@shared/session/sessionView';
import {
  flowPosition,
  formatFlowPositionLabel,
} from '@shared/runs/runStatusDisplay';
import { formatWorkflowPhaseHeading } from '@ui/copy/workflowCall';

/** The bound bridge, itself a signal so a computed over the view (the
 *  approval Surface's foreground) re-tracks when a chat session rebinds. */
const bound = signal<StreamSignal<SessionView> | undefined>(undefined);

/**
 * Bridge a session's view level into the TUI's signal; returns the unbind.
 * The only meeting point between Effect and the components (PRD 7.5): the
 * view's change run bridged onto `runtime` by `toSignal` — the process
 * runtime the chat entry point holds, since the bridge lives as long as the
 * session it binds.
 *
 * A session binds `changes` to `SessionHandle.viewChanges`, the level stream
 * that fails when the fold dies: the ref's own changes never fail, so a TUI
 * reading only those would freeze on a dead fold with nothing to say.
 * `onFailure` is that word, as the one error the cause squashes to, so the
 * entry that binds needs no Effect vocabulary; a fixture that binds a bare
 * ref needs neither.
 */
export function bindSessionView(
  runtime: ProcessRuntime,
  view: SubscriptionRef.SubscriptionRef<SessionView>,
  options: {
    readonly changes?: Stream.Stream<SessionView>;
    readonly onFailure?: (error: unknown) => void;
  } = {},
): () => void {
  bound.get()?.dispose();
  const changes = (options.changes ?? SubscriptionRef.changes(view)).pipe(
    Stream.catchCause((cause) => {
      if (!Cause.hasInterruptsOnly(cause)) {
        options.onFailure?.(Cause.squash(cause));
      }
      return Stream.empty;
    }),
  );
  const bridgedBound = toSignal(
    runtime,
    changes,
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
      'The session view is not bound: call bindSessionView(runtime, session.view) before rendering the TUI.',
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

/** The run to resume when it was interrupted and can pick up again. */
export function resumableRunId(run: RunView | undefined): RunId | undefined {
  return run?.group === 'interrupted' && run.resumeEligible
    ? run.id
    : undefined;
}

/** This composer's capability for `acceptsFollowUp`: it does not address a
 *  terminal-backed run (an external agent CLI's session). Every other
 *  follow-up decision is the shared rule's. */
export const CLI_FOLLOW_UP_HOST: FollowUpHost = { terminalBacked: false };

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

/**
 * The nearest ancestor's position, for a child's location: the loop's own
 * coordinate off `RunView.flow`, and the open phase for a workflow-script
 * ancestor, which drives no loop of its own — its child loop is terminal on
 * the first turn, so it never writes a `flow.step` and its `flow` stays null.
 */
export function ancestorPositionLabel(
  view: SessionView,
  runId: RunId,
): string | undefined {
  const ancestors = runViewOf(view, runId)?.ancestors ?? [];
  // Root first in the view; the nearest ancestor that has a position wins.
  for (const ancestor of ancestors.toReversed()) {
    const run = runViewOf(view, ancestor.id);
    if (run === undefined) continue;
    const label =
      formatFlowPositionLabel(flowPosition(run.flow)) ??
      openWorkflowPhaseLabel(run);
    if (label !== undefined) return label;
  }
  return undefined;
}

/** The phase a workflow-script run has opened most recently, spelled by the
 *  one owner of phase-heading copy. Only a workflow-script run carries a run
 *  model, so every other run has no phase to name. */
function openWorkflowPhaseLabel(run: RunView): string | undefined {
  const opened = run.transcript.run?.phases.findLast((phase) => phase.opened);
  return opened === undefined
    ? undefined
    : formatWorkflowPhaseHeading(opened.heading);
}
