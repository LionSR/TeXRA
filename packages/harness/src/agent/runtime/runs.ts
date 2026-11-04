/**
 * A session's runs as hosts and tools reach them ({@link RunsShape}). The
 * registry behind them (`runRegistry.ts`) is the harness internals'; the
 * `Runs` tag that serves these is its module's.
 */

import type { RunId, RunStopReason } from '@shared/schemas';
import type { Effect } from 'effect';
import type { SessionServices } from './rootLaunch';

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

/** What this process holds for one run: a launch or resume of it in flight
 *  here, from the call (before its fiber claims the lane) until its fiber
 *  exits, which is what a stop reaches. Read when asked; a run with none
 *  has no record (`RunsShape.get`). */
export interface LiveRun {
  readonly runId: RunId;
  /** Its running loop's controls, while one runs here. */
  readonly controls: RunControls | undefined;
  /** Whether the generation live here reads a message: a one-shot loop
   *  (headless, or an in-band child) ends after its turn and reads none,
   *  and a run with no loop of its own (a background command) reads what
   *  its launch said it takes. */
  readonly readsMessages: boolean;
  /** Resolves once every owner of it here has left. */
  readonly drained: Effect.Effect<void>;
}

/**
 * A session's runs, as hosts and tools reach them: stop one, and read what
 * this process holds of them. A root starts through `session.start`
 * (`rootRun`, which requires the composition root's `SessionOwner`, given
 * to no tool); a run resumes through `resumeRun`.
 */
export interface RunsShape {
  /** Stop a run for `reason`. A `user` stop is an explicit stop of the
   *  work: the run cancels the remote background operation it is observing,
   *  and its children follow the session's "Keep agents running" setting,
   *  read as the stop runs (a detached child runs on as a root, and an
   *  in-band call awaiting it stops only its wait). A `shutdown` stop only
   *  ends this process's hold on the run, leaving that operation for a
   *  resume to observe, and ends its children's holds with it. */
  stop(runId: RunId, reason: RunStopReason): RunStop;
  /** What this process holds for `runId`, or undefined while no launch of
   *  it is in flight here. */
  get(runId: RunId): LiveRun | undefined;
  get(): readonly LiveRun[];
  /** Why the launch of `runId` here is stopping, while it unwinds from that
   *  stop: the one answer to whether a stop reached it, and how. */
  stopCause(runId: RunId): StopCause | undefined;
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
   *  batch, or the terminal row of a stop that reached no live target, which
   *  it writes over the session's services from its caller's context. */
  readonly settlement: Effect.Effect<void, Error, SessionServices>;
}

/** Why a run here stops: a stop's reason, or `released`: its holder let go
 *  of it (the last caller of a resume left before any took it, or a handle
 *  or an in-band call interrupted it). Before admission a `released` stop,
 *  like `shutdown`, writes no end and leaves the run resumable; an admitted
 *  run that is interrupted ends `cancelled` through its lifecycle. */
export type StopCause = RunStopReason | 'released';
