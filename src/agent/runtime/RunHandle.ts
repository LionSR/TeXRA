/**
 * Live run handle and terminal settlement.
 *
 * A handle owns one run's identity, its parent edge, its live controls
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

/** One live parent edge, retained by a native activation and its handles. */
export interface RunParent {
  current: RunId | null;
}

/**
 * What a host can ask of a running tool-use loop: the members something
 * reads, and nothing else. The loop attaches them to its handle while it can
 * act on them; a stop is the run fiber's interruption, not a control.
 */
export interface RunControls {
  /** The loop ends after its current turn (`stopAfterCycle`): it reads no
   *  input, so nothing may queue a message on it. A resume of the same run
   *  may not be one-shot, which is why this is the live loop's, not the
   *  launch's `followUpSupport`. */
  readonly oneShot: boolean;
  requestImmediateCompaction(): void;
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
 * Handle for agent-based runs (workflow or toolUse subagents). A handle
 * with a parent represents a child whose results route to that parent.
 */
export class RunHandle<
  Trace extends AgentTrace | undefined = AgentTrace | undefined,
> {
  /** @internal The registry shares this cell across one activation's handles. */
  parentState: RunParent;
  private liveControls?: RunControls;

  /**
   * The background OS process this run owns, when a strategy declared one
   * (a background bash child, an agent-CLI child): the narrow survivor of
   * the interrupt-handler slot, read only by
   * `RunRegistry.killBackgroundProcesses` to reach a leaked process at
   * shutdown WITHOUT ending native agent runs (#8155), the opposite contract
   * of a run stop, which is the run fiber's interruption.
   */
  backgroundProcess?: { kill(): void };

  constructor(
    /**
     * The run's birth facts, the same object its `run.start` published and its
     * `run.end` row closes. Held whole rather than copied field by field,
     * so the handle and the event plane cannot describe the run differently.
     */
    readonly run: RunFacts,
    parent: RunId | null,
    /** The run's discriminated-event channel, for run-scoped subscribers:
     *  present on every launched run, absent on a process or external-CLI
     *  run's handle, which the type parameter records. */
    readonly trace: Trace = undefined as Trace,
  ) {
    this.parentState = { current: parent };
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

  /** The launching run this run's results route to, or null for a root and
   *  for a child the registry has detached. */
  get parent(): RunId | null {
    return this.parentState.current;
  }

  /**
   * True when this run is a live child whose results deliver to
   * `callerRunId` — the one caller-ownership authorization check. Reads the
   * live parent edge, so a detached child answers false to its former
   * orchestrator.
   */
  isOwnedBy(callerRunId: RunId | null | undefined): boolean {
    return callerRunId != null && this.parentState.current === callerRunId;
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
