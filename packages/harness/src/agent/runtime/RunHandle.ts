/**
 * Live run handle and terminal settlement.
 *
 * A handle owns one run's identity, its launch's parent, its live controls
 * (while a tool-use loop runs), and its exactly-once
 * terminal settlement. A run's stop is its fiber's interruption
 * (`RunRegistry.interrupt`), never a call on this handle. Termination
 * policy lives with the owning registry.
 */

import type { AgentTrace } from '@agent/trace';
import type { RunId, RunIdentity } from '@shared/schemas';
import { runIdentityName } from '@shared/schemas';
import type { Effect } from 'effect';

/**
 * The run's immutable birth facts, the same values `run.start` publishes and
 * `registerRun` persists.
 */
export interface RunFacts {
  readonly runId: RunId;
  readonly identity: RunIdentity;
}

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
  /**
   * Reset the run's view at its next park (`handoff` null), or hand off:
   * the reset with `handoff` as the message its next turn answers. Settles
   * once the edit's rows commit.
   */
  editView(handoff: string | null): Effect.Effect<void, Error>;
  modelSwitchDisabledReason(
    model: string,
  ): Effect.Effect<string | undefined, Error>;
  switchModel(model: string): Effect.Effect<void, Error>;
}

/**
 * Handle for one live agent run. The parent
 * edge is not the handle's: it is the run's rows (`RunRegistry.parentOf`).
 */
export class RunHandle<
  Trace extends AgentTrace | undefined = AgentTrace | undefined,
> {
  private liveControls?: RunControls;
  /** The run that launched this one, as its launch named it: the parent its
   *  birth writes, never cut. A detach is the rows' (`parentOf`). */
  readonly launchParent: RunId | null;

  constructor(
    /**
     * The run's birth facts, the same object its `run.start` published and its
     * `run.end` row closes. Held whole rather than copied field by field,
     * so the handle and the event plane cannot describe the run differently.
     */
    readonly run: RunFacts,
    launchParent: RunId | null,
    /** The run's discriminated-event channel, for run-scoped subscribers:
     *  present on every launched run, absent on a process or external-CLI
     *  run's handle, which the type parameter records. */
    readonly trace: Trace = undefined as Trace,
  ) {
    this.launchParent = launchParent;
  }

  get runId(): RunId {
    return this.run.runId;
  }

  get identity(): RunIdentity {
    return this.run.identity;
  }

  get agentName(): string {
    return runIdentityName(this.run.identity);
  }

  attachControls(controls: RunControls): void {
    this.liveControls = controls;
  }

  detachControls(controls: RunControls): void {
    if (this.liveControls !== controls) return;
    this.liveControls = undefined;
  }

  /** The loop's controls while it runs; `undefined` while none does. */
  get controls(): RunControls | undefined {
    return this.liveControls;
  }
}
