/**
 * A session's runs as hosts and tools reach them ({@link RunsShape}). The
 * registry behind them (`runRegistry.ts`) is the harness internals'; the
 * `Runs` tag that serves these is its module's.
 */

import type { SessionOwner } from '@platform/processRuntime';
import type { RunId } from '@shared/schemas';
import type { RunStopReason } from '@shared/session/runtimeRequest';
import type { Effect, Scope } from 'effect';
import type { RunControls, RunHandle } from './RunHandle';
import type { RunEndResult } from './RunEndResult';
import type { RootLaunchOptions, RootLaunchRequest } from './rootLaunch';
import type { resumeRun } from './resumeRun';

/** A root launch: what to run, and how its launch settles. */
export interface RootLaunch {
  readonly request: RootLaunchRequest;
  readonly options: RootLaunchOptions;
}

/** What this process holds for one run, read when asked. */
export interface LiveRun {
  readonly runId: RunId;
  /** Its tracked handle (its identity). */
  readonly handle: RunHandle | undefined;
  /** Its running loop's controls, while one runs here. */
  readonly controls: RunControls | undefined;
  /** A generation of it is live here: its fiber, a hold, or a launch. */
  readonly live: boolean;
  /** Whether the generation live here reads a message: a one-shot loop
   *  (headless, or an in-band child) ends after its turn and reads none,
   *  and a run with no loop of its own (a background command) reads what
   *  its launch said it takes. */
  readonly readsMessages: boolean;
  /** Why it was stopped here, while it unwinds from that stop. */
  readonly stopReason: RunStopReason | undefined;
  /** Resolves once every owner of it here has left. */
  readonly drained: Effect.Effect<void>;
}

/**
 * A session's runs, as hosts and tools reach them: launch one (a root, or a
 * hold on a stopped one), resume one, stop one, and read what this process
 * holds of them. A root launch requires the composition root's
 * `SessionOwner`, which no tool is given.
 */
export interface RunsShape {
  launch(spec: RootLaunch): Effect.Effect<RunEndResult, Error, SessionOwner>;
  /** Hold a stopped run for the caller's scope, its claim taken: refused
   *  while it is live here or held elsewhere. */
  launch(spec: {
    readonly hold: RunId;
  }): Effect.Effect<void, Error, Scope.Scope>;
  readonly resume: typeof resumeRun;
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
