/**
 * Live run handle and terminal settlement.
 *
 * A handle owns one run's identity, its parent edge, its live control
 * surfaces (interrupt, tool-use flow, run lease), and its exactly-once
 * terminal settlement. Termination policy lives with the owning registry.
 */

import type { AgentTrace } from '@agent/trace';
import type { ToolUseFlowContext } from '@agent/runtime/loop/toolUse';
import type {
  AgentCategory,
  RunId,
  RunIdentity,
  RunPhase,
} from '@shared/schemas';
import { runIdentityName } from '@shared/schemas';
import type { Effect } from 'effect';

export interface RunStatusInfo {
  status: RunPhase | 'unknown';
  elapsed: string | null;
  /**
   * Why the status reads the way it does, when the phase alone would mislead:
   * a run another process holds, or one interrupted with a checkpoint still
   * on disk. Rendered after the status by `formatStatusInfo`.
   */
  detail?: string;
}

/**
 * The run's immutable birth facts, the same values `run.start` publishes and
 * `registerRun` persists. `category` is the launch-time in-memory
 * config's run mode — never re-read from a persisted record or a
 * display projection.
 */
export interface RunFacts {
  readonly runId: RunId;
  readonly identity: RunIdentity;
  readonly category: AgentCategory;
}

/** Live run-owned capability that can receive a user stop request. */
export interface RunInterruptHandler {
  interrupt(): void;
  /**
   * True when `interrupt()` tears down a live background OS process (e.g. a
   * background bash child), as opposed to merely cancelling an in-flight
   * agent turn or a resumable native-subagent loop. Shutdown drain reads this
   * to reach a leaked background process (see
   * `RunRegistry.killBackgroundProcesses`) without disturbing agent
   * runs that are intentionally left running for restart recovery.
   */
  readonly ownsBackgroundProcess?: boolean;
}

/**
 * A run parked at WAITING, and whether a stop has already claimed its teardown.
 *
 * Presence is the authoritative suspension fact: only the WAITING branch of
 * `runFlowWithLifecycle` parks a handle, so no reader has to cross-check the
 * run phase to learn whether a run is really suspended.
 */
type RunSuspension =
  | { readonly state: 'parked'; readonly teardown: Effect.Effect<void, Error> }
  | { readonly state: 'terminating' };

/**
 * The projection of the flow's {@link ToolUseFlowContext} that a run handle
 * retains for its lifetime.
 *
 * This is derived from — not a parallel re-declaration of — {@link
 * ToolUseFlowContext}, so a shape change to either surface fails type-checking
 * instead of silently diverging: the nested `modelHandler` view is a `Pick` of
 * the flow context's own type, and the method members are picked through
 * directly. The loop's context is deliberately richer (it owns the run's
 * `FollowUps` lease and the bound model); the handle keeps only what a
 * consumer of an attached run needs.
 *
 * {@link RunHandle.interrupt} falls back to this context's
 * `interrupt()` when no explicit {@link RunInterruptHandler} is
 * attached. Native child-run strategies use it to delegate a
 * child-run-loop-level interrupt into an in-flight tool-use turn. A live
 * `flowContext` is attached via `attachToolUseFlow` for the duration of one
 * turn and knows how to cancel the in-progress model/tool round.
 */
export type LiveToolUseFlowContext = {
  readonly modelHandler: Pick<
    ToolUseFlowContext['modelHandler'],
    'supportsManualCompaction'
  >;
} & Pick<
  ToolUseFlowContext,
  | 'ownerSession'
  | 'requestImmediateCompaction'
  | 'modelSwitchDisabledReason'
  | 'switchModel'
  | 'interrupt'
>;

/**
 * Handle for agent-based runs (workflow or toolUse subagents). A handle
 * with a parent represents a child whose results route to that parent.
 */
export class RunHandle<
  Trace extends AgentTrace | undefined = AgentTrace | undefined,
> {
  /**
   * Epoch ms when this handle generation was created. The value remains on a
   * handle while it is parked at WAITING. Resume constructs and tracks a
   * replacement handle, whose `startedAt` is stamped anew. This feeds the
   * roster's `ActiveChildInfo.startedAt` and the `executions` tool's `Started:`
   * line.
   * Durable run creation time is `RunView.launchedAt`.
   */
  readonly startedAt = Date.now();
  /**
   * The parent edge, the same value the run's `run.start` carries; null for
   * a root. `detach` is its one write, so "is a child", the delivery target,
   * and caller ownership can never disagree.
   */
  private _parent: RunId | null;
  private interruptHandler?: RunInterruptHandler;
  private toolUseFlowContext?: LiveToolUseFlowContext;
  private suspension?: RunSuspension;

  /**
   * Workflow-script phase owning this run, when it is an `agent()` grandchild
   * of a workflow-script run. A mutable display-field slot, assigned between
   * construction and `track()`, so the first roster emission already carries
   * it.
   */
  workflowPhase?: string;

  /** Whether a caller has claimed the run's exactly-once terminal outcome. */
  private terminalClaimed = false;

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
    this._parent = parent;
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

  get category(): AgentCategory {
    return this.run.category;
  }

  /**
   * Atomically claim the exactly-once terminal finalization of this handle.
   * Returns true for exactly one caller — the flag flips synchronously in the
   * same tick as the check, so two `finalizeRunTerminal` calls racing across
   * await points (e.g. a lifecycle arm vs a concurrent finalize of the same
   * handle) cannot both win. A stop of a suspended run claims through the same
   * gate ({@link beginSuspendedTermination}), so the run lifecycle and the
   * registry cannot both publish a terminal outcome for one run.
   */
  claimTerminalFinalize(): boolean {
    if (this.terminalClaimed) return false;
    this.terminalClaimed = true;
    return true;
  }

  /** The launching run, or null for a root and for a detached child. */
  get parent(): RunId | null {
    return this._parent;
  }

  get isChild(): boolean {
    return this._parent !== null;
  }

  /**
   * The parent this run's results route to, or `undefined` once the run has
   * none (a root run, or a subagent promoted by {@link detach}).
   */
  get deliveryTarget(): RunId | undefined {
    return this._parent ?? undefined;
  }

  /** Promote this subagent to a top-level run (detach from parent). */
  detach(): void {
    this._parent = null;
  }

  /**
   * True when this run is a live child whose results deliver to
   * `callerRunId` — the one caller-ownership authorization check. Reads the
   * live parent edge, so a detached child answers false to its former
   * orchestrator.
   */
  isOwnedBy(callerRunId: RunId | null | undefined): boolean {
    return callerRunId != null && this._parent === callerRunId;
  }

  attachToolUseFlow(context: LiveToolUseFlowContext): void {
    if (this.category !== 'toolUse') {
      throw new Error('Only tool-use run handles can attach tool flows.');
    }
    this.toolUseFlowContext = context;
  }

  detachToolUseFlow(context: LiveToolUseFlowContext): void {
    if (this.toolUseFlowContext !== context) return;
    this.toolUseFlowContext = undefined;
  }

  getToolUseFlow(): LiveToolUseFlowContext | undefined {
    return this.toolUseFlowContext;
  }

  attachInterruptHandler(handler: RunInterruptHandler): () => void {
    this.interruptHandler = handler;
    return () => {
      if (this.interruptHandler === handler) this.interruptHandler = undefined;
    };
  }

  interrupt(): boolean {
    const handler = this.interruptHandler;
    if (handler) {
      handler.interrupt();
      return true;
    }
    const context = this.toolUseFlowContext;
    if (context) {
      context.interrupt();
      return true;
    }
    return false;
  }

  /**
   * Interrupt this handle's attached background OS process, if any — the
   * case shutdown drain needs, distinct from `interrupt()`'s general stop
   * (which also covers a loop-level or in-flight-turn interrupt handler that
   * must stay untouched on shutdown so restart recovery can find it). Only a
   * child-run loop whose strategy declares `ownsBackgroundProcess` sets this —
   * background bash is the one that does. Returns whether a background-process
   * interrupt handler was attached and interrupted.
   */
  interruptBackgroundProcess(): boolean {
    if (this.interruptHandler?.ownsBackgroundProcess !== true) return false;
    this.interruptHandler.interrupt();
    return true;
  }

  /**
   * Park this handle at WAITING, carrying the teardown a stop must run.
   *
   * The live tool-use session and interrupt context are already gone by the
   * time a run suspends (the tool-use loop's scope detaches them on return)
   * while the handle stays tracked so a later resume can find it, so
   * `RunRegistry.terminate()` reaches a suspended run through
   * {@link beginSuspendedTermination} instead of a live interrupt (#7287).
   */
  suspend(teardown: Effect.Effect<void, Error>): void {
    this.suspension = { state: 'parked', teardown };
  }

  /** True once a stop claimed this suspended run and owns its teardown. */
  get suspendedTerminationStarted(): boolean {
    return this.suspension?.state === 'terminating';
  }

  /**
   * Claim the terminal outcome of a run parked at WAITING and return its
   * native teardown. Returns undefined when this
   * handle never parked, when a stop already claimed it, or when a
   * `finalizeRunTerminal` already claimed the run's terminal outcome. The whole
   * transition is synchronous, so a stop and a concurrent finalize of the same
   * handle cannot both proceed.
   */
  beginSuspendedTermination(): Effect.Effect<void, Error> | undefined {
    if (this.suspension?.state !== 'parked') return undefined;
    if (!this.claimTerminalFinalize()) return undefined;
    const { teardown } = this.suspension;
    this.suspension = { state: 'terminating' };
    return teardown;
  }
}

/**
 * A launched run's handle as `onRun` hands it to the caller: every launch
 * constructs it over the run's own trace, so the trace is present by type.
 */
export type AgentRunHandle = Pick<
  RunHandle<AgentTrace>,
  | 'runId'
  | 'parent'
  | 'isChild'
  | 'identity'
  | 'category'
  | 'agentName'
  | 'startedAt'
  | 'trace'
  | 'deliveryTarget'
  | 'interrupt'
>;
