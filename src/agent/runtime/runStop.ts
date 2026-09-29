/**
 * A stop's contract with `RunRegistry.stop`: what the caller declares
 * (child policy and reason) and what it gets back.
 */
import type { RunStopReason } from '@shared/session/runtimeRequest';
import type { Effect } from 'effect';

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
