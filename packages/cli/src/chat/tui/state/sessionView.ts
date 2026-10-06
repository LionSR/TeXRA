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
import {
  RUN_LIFECYCLE_READY,
  RUN_PHASE,
  type RunPhase,
  type RunId,
} from '@shared/schemas';
import type {
  FollowUpHost,
  SessionView,
  RunView,
} from '@shared/session/sessionView';
import { toSignal, type StreamSignal } from '@texra/shared/signals';
import type { ProcessRuntime } from '@texra-ai/harness';

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

/** The child run a kill targets, while its `actions` offers a stop. */
export function killableRunId(run: RunView | undefined): RunId | undefined {
  return run && run.parentId !== null && run.actions.includes('stop')
    ? run.id
    : undefined;
}

/** The interrupted run a resume picks up, while its `actions` offers one. */
export function resumableRunId(run: RunView | undefined): RunId | undefined {
  return run?.group === 'interrupted' && run.actions.includes('resume')
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
 * counts every descendant still working a turn, a child waiting on the user
 * included; the TUI's "active" is direct children in the RUNNING phase, so
 * it reads each child's status fact rather than the rollup.
 */
export function runningChildCount(
  view: SessionView,
  run: RunView | undefined,
): number {
  return (run?.childIds ?? []).filter(
    (id) => view.runs.get(id)?.status === RUN_PHASE.RUNNING,
  ).length;
}
