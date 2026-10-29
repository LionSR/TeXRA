/**
 * A session's runs as hosts and tools reach them ({@link RunsShape}). The
 * registry behind them (`runRegistry.ts`) is the harness internals'; the
 * `Runs` tag that serves these is its module's.
 */

import type { SessionOwner } from '@platform/processRuntime';
import type { CommitOrdinal, RunId } from '@shared/schemas';
import type { RunStopReason } from '@shared/session/runtimeRequest';
import type { Effect, Scope } from 'effect';
import type { RootLaunchOptions, RootLaunchRequest } from './rootLaunch';

/** A root launch: what to run, and with which options. */
export interface RootLaunch {
  readonly request: RootLaunchRequest;
  readonly options: RootLaunchOptions;
}

/**
 * What a host can ask of a running tool-use loop: the members something
 * reads, and nothing else. The loop attaches them to its run's entry while it
 * can act on them; a stop is the run fiber's interruption, not a control.
 */
export interface RunControls {
  /** The loop ends after its current turn (`stopAfterCycle`), or the one a
   *  Stop hook's block opens: it reads no input, so nothing may queue a
   *  message on it. A resume of the same run
   *  may not be one-shot, which is why this is the live loop's, not the
   *  launch's `followUpSupport`. */
  readonly oneShot: boolean;
  modelSwitchDisabledReason(
    model: string,
  ): Effect.Effect<string | undefined, Error>;
  switchModel(model: string): Effect.Effect<void, Error>;
}

/** What this process holds for one run, read when asked. */
export interface LiveRun {
  readonly runId: RunId;
  /** Its running loop's controls, while one runs here. */
  readonly controls: RunControls | undefined;
  /** A generation of it is live here: its fiber, a hold, or a launch. */
  readonly live: boolean;
  /** A launch or resume of it is in flight here, from the call (before its
   *  fiber claims the lane) until its fiber exits: what a stop reaches. */
  readonly launched: boolean;
  /** Its attached parent: the view's edge, or for a child whose `run.start`
   *  the view has not folded yet, the parent its activation launched under;
   *  null for a root. */
  readonly parent: RunId | null;
  /** Whether the generation live here reads a message: a one-shot loop
   *  (headless, or an in-band child) ends after its turn and reads none,
   *  and a run with no loop of its own (a background command) reads what
   *  its launch said it takes. */
  readonly readsMessages: boolean;
  /** Why it was stopped here, while it unwinds from that stop. */
  readonly stopReason: StopCause | undefined;
  /** Resolves once every owner of it here has left. */
  readonly drained: Effect.Effect<void>;
}

/**
 * A session's runs, as hosts and tools reach them: launch one (a root, or a
 * hold on a stopped one), stop one, and read what this process holds of
 * them; a run resumes through `resumeRun`. A root launch requires the
 * composition root's `SessionOwner`, which no tool is given.
 */
export interface RunsShape {
  /** Launch a root run: the commit of its opening, once that commits. */
  launch(spec: RootLaunch): Effect.Effect<CommitOrdinal, Error, SessionOwner>;
  /** Hold a stopped run for the caller's scope, its claim taken: refused
   *  while it is live here or held elsewhere. */
  launch(spec: {
    readonly hold: RunId;
  }): Effect.Effect<void, Error, Scope.Scope>;
  stop(runId: RunId, options: RunStopOptions): RunStop;
  get(runId: RunId): LiveRun | undefined;
  get(): readonly LiveRun[];
}

/**
 * One stop. A cascading stop reaches its targets when it is issued; a
 * detaching one only after {@link settlement} has committed the detach batch
 * and severed the children locally, so {@link accepted} answers `false` until
 * that has run. A caller that must decide synchronously is therefore a caller
 * that cascades (headless shutdown, session close).
 */
export interface RunStop {
  /** Whether a live interrupt target took the stop. */
  readonly accepted: () => boolean;
  /** Fails when a durable fact the stop owed storage was refused: a detach
   *  batch, or the terminal row of a stop that reached no live target. */
  readonly settlement: Effect.Effect<void, Error>;
}

/** Why a run here stops: a stop's reason, or `released`: its holder let go
 *  of it (the last caller of a resume left before any took it, or a handle
 *  or an in-band call interrupted it). Before admission a `released` stop,
 *  like `shutdown`, writes no end and leaves the run resumable; an admitted
 *  run that is interrupted ends `cancelled` through its lifecycle. */
export type StopCause = RunStopReason | 'released';

/** Child policy of a stop. An explicit value wins: the CLI's bare-Escape stop
 *  always detaches and shutdown always cascades. A `run.stop` request that
 *  leaves it unset is resolved by the session request handler through
 *  `detachSubagentsOnStop()`; a missing option here reads as cascade, since a
 *  child left running has no owner. */
export interface RunStopOptions {
  readonly detachActiveChildren?: boolean;
  /** Why the run stops. A `user` stop is an explicit stop of the work: the
   *  run cancels the remote background operation it is observing. A
   *  `shutdown` stop only ends this process's hold on the run, leaving that
   *  operation for a resume to observe. */
  readonly reason: RunStopReason;
}
