/**
 * A session's runs as hosts and tools reach them ({@link RunsShape}). The
 * registry behind them (`runRegistry.ts`) is the harness internals'; the
 * `Runs` tag that serves these is its module's.
 */

import type { RunId, RunStopReason } from '@shared/schemas';
import type { Effect } from 'effect';

/**
 * What a host can ask of a running tool-use loop: the members something
 * reads, and nothing else. The loop attaches them to its run while it can
 * act on them; a stop is the run fiber's interruption, not a control.
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

/** What this process holds for one run: the fiber that drives it here,
 *  from its launch until that fiber exits, which is what a stop reaches.
 *  Read when asked; a run with none has no record (`RunsShape.get`). */
export interface LiveRun {
  readonly runId: RunId;
  /** Its running loop's controls, while one runs here. */
  readonly controls: RunControls | undefined;
  /** Whether the loop live here reads a message: a one-shot loop
   *  (headless, or an in-band child) ends after its turn and reads none,
   *  and a run with no loop of its own (a background command) reads what
   *  its launch said it takes. */
  readonly readsMessages: boolean;
  /** Resolves once the fiber driving it here has exited. */
  readonly drained: Effect.Effect<void>;
}

/**
 * A session's runs, as hosts and tools reach them: stop one, and read what
 * this process holds of them. A root starts through `session.start`
 * (`rootRun`, which requires the composition root's `SessionOwner`, given
 * to no tool); a run resumes through `resumeRun`.
 */
export interface RunsShape {
  /** Stop a run for `reason`: its `run.stop` row commits, then the fiber
   *  driving it here is interrupted, whose end reads the reason from that
   *  row. A `user` stop is an explicit stop of the work: the run cancels
   *  the remote background operation it is observing, and its children
   *  follow the session's "Keep agents running" setting, read as the stop
   *  runs (a detached child runs on as a root, and an in-band call awaiting
   *  it stops only its wait). A `shutdown` stop only ends this process's
   *  hold on the run, leaving that operation for a resume to observe, and
   *  ends its children's holds with it. A run no fiber here drives ends
   *  CANCELLED in the batch that records the stop. Resolves to whether a
   *  fiber here took the stop; fails when the rows the stop owed storage
   *  were refused. */
  stop(runId: RunId, reason: RunStopReason): Effect.Effect<boolean, Error>;
  /** What this process holds for `runId`, or undefined while no fiber here
   *  drives it. */
  get(runId: RunId): LiveRun | undefined;
  get(): readonly LiveRun[];
}
