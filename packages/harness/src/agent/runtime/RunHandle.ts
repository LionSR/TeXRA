/**
 * Live run handle.
 *
 * A handle owns one run's identity, its launch's parent and its live
 * controls (while a tool-use loop runs). A run's stop is its fiber's interruption
 * (`RunRegistry.interrupt`), never a call on this handle. Termination
 * policy lives with the owning registry.
 */

import type { RunId, RunIdentity } from '@shared/schemas';
import { runIdentityName } from '@shared/schemas';
import type { Effect } from 'effect';

/**
 * What a host can ask of a running tool-use loop: the members something
 * reads, and nothing else. The loop attaches them to its handle while it can
 * act on them; a stop is the run fiber's interruption, not a control.
 */
export interface RunControls {
  /** The loop ends after its current turn (`stopAfterCycle`), or the one a
   *  Stop hook's block opens: it reads no input, so nothing may queue a
   *  message on it. A resume of the same run
   *  may not be one-shot, which is why this is the live loop's, not the
   *  launch's `followUpSupport`. */
  readonly oneShot: boolean;
  /** Queue a `/compact` on the run's input; settles once its row commits. */
  requestImmediateCompaction(): Effect.Effect<void, Error>;
  modelSwitchDisabledReason(
    model: string,
  ): Effect.Effect<string | undefined, Error>;
  switchModel(model: string): Effect.Effect<void, Error>;
}

/**
 * Handle for one live agent run. The parent
 * edge is not the handle's: it is the run's rows (`RunRegistry.parentOf`).
 */
export class RunHandle {
  /** The run's id and identity: the same values its `run.start` publishes
   *  and `registerRun` persists, fixed for the run's life. */
  readonly runId: RunId;
  readonly identity: RunIdentity;
  /** The run that launched this one, as its launch named it: the parent its
   *  birth writes, never cut. A detach is the rows' (`parentOf`). */
  readonly launchParent: RunId | null;
  private liveControls?: RunControls;

  constructor(
    run: Pick<RunHandle, 'runId' | 'identity'>,
    launchParent: RunId | null,
  ) {
    this.runId = run.runId;
    this.identity = run.identity;
    this.launchParent = launchParent;
  }

  get agentName(): string {
    return runIdentityName(this.identity);
  }

  /** The loop's controls while it runs; `undefined` while none does. */
  get controls(): RunControls | undefined {
    return this.liveControls;
  }

  /** The running loop attaches its controls as it starts. */
  attach(controls: RunControls): void {
    this.liveControls = controls;
  }

  /** The loop detaches its controls as it ends; controls a later loop
   *  attached are kept. */
  detach(controls: RunControls): void {
    if (this.liveControls !== controls) return;
    this.liveControls = undefined;
  }
}
