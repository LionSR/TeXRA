/**
 * Live agent execution handle and terminal settlement.
 *
 * A handle owns one run's identity, its live control surfaces (interrupt,
 * tool-use flow, execution lease), and its exactly-once terminal settlement.
 * Termination policy lives with the owning registry.
 */

import { Deferred, Effect } from 'effect';

import type { AgentTrace, ResultEvent } from '@agent/trace';
import type { ToolUseFlowContext } from '@agent/implementations/flows/tooluse/runToolUseFlow';
import type {
  AgentCategory,
  RunId,
  RunIdentity,
  RunPhase,
  StreamTabId,
} from '@shared/schemas';
import { runIdentityName } from '@shared/schemas';

export interface ExecutionStatusInfo {
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
 * `registerExecution` persists. `category` is the launch-time in-memory
 * config's execution mode — never re-read from a persisted record or a
 * display projection.
 */
export interface RunDescriptor {
  readonly streamId: StreamTabId;
  readonly executionId: RunId;
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
   * `ExecutionRegistry.killBackgroundProcesses`) without disturbing agent
   * executions that are intentionally left running for restart recovery.
   */
  readonly ownsBackgroundProcess?: boolean;
}

/**
 * A run parked at WAITING, and whether a stop has already claimed its teardown.
 *
 * Presence is the authoritative suspension fact: only the WAITING branch of
 * `runFlowWithLifecycle` parks a handle, so no reader has to cross-check the
 * stream phase to learn whether a run is really suspended.
 */
type RunSuspension =
  | { readonly state: 'parked'; readonly teardown: Effect.Effect<void, Error> }
  | { readonly state: 'terminating' };

/**
 * How far the run's exactly-once terminal outcome has progressed.
 *
 * `claimed` is the window between a caller winning {@link
 * AgentExecutionHandle.claimTerminalFinalize} and the result actually
 * settling; `settled` is reachable directly for the non-lifecycle child
 * streams that settle without claiming. Both refuse a further claim, which is
 * why this is one ordered state rather than two independent flags.
 */
type TerminalState = 'open' | 'claimed' | 'settled';

/**
 * The projection of the flow's {@link ToolUseFlowContext} that an execution
 * handle retains for its lifetime.
 *
 * This is derived from — not a parallel re-declaration of — {@link
 * ToolUseFlowContext}, so a shape change to either surface fails type-checking
 * instead of silently diverging: the nested `modelHandler` view is a `Pick` of
 * the flow context's own type, and the method members are picked through
 * directly. `runToolUseFlow`'s context is deliberately richer (it owns
 * the live `ToolUseSessionLifecycle` and the full `RunModelHandler`); the
 * handle keeps only what a consumer of an attached run needs.
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
 * Handle for agent-based executions (workflow or toolUse subagents).
 * When `parentStreamId` differs from `childStreamId`, the handle represents
 * a subagent whose parent is an orchestrator.
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
   * Durable execution creation time is `ExecutionMeta.timestamp`.
   */
  readonly startedAt = Date.now();
  private _parentStreamId: StreamTabId;
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

  /**
   * The run's terminal outcome, settled exactly once (by the run lifecycle, or
   * by `finalizeChildStream` for non-lifecycle child streams) BEFORE the
   * execution is untracked. It always succeeds — it has no error channel — so
   * a failed run reports through the `ResultEvent`'s own outcome rather than
   * through a rejection nobody is required to observe, and a consumer that
   * never awaits it costs nothing. Awaiting it is a fiber parked on the
   * `Deferred`, so an interrupted consumer detaches with its fiber. SDK
   * consumers awaiting a specific run's outcome use this; the host-wide
   * stream is `session.onResult`.
   */
  private readonly _terminal = Deferred.makeUnsafe<ResultEvent>();
  readonly result: Effect.Effect<ResultEvent> = Deferred.await(this._terminal);
  private terminalState: TerminalState = 'open';

  constructor(
    /**
     * The run's birth facts, the same object its `run.start` published and its
     * terminal `result` reports. Held whole rather than copied field by field,
     * so the handle and the event plane cannot describe the run differently.
     */
    readonly run: RunDescriptor,
    parentStreamId: StreamTabId,
    /** The run's discriminated-event channel, for run-scoped subscribers:
     *  present on every launched run, absent on a process or external-CLI
     *  stream's handle, which the type parameter records. */
    readonly trace: Trace = undefined as Trace,
  ) {
    this._parentStreamId = parentStreamId;
  }

  get executionId(): RunId {
    return this.run.executionId;
  }

  get childStreamId(): StreamTabId {
    return this.run.streamId;
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

  /** Settle {@link result} with the terminal outcome (idempotent). */
  settleResult(event: ResultEvent): void {
    this.terminalState = 'settled';
    Deferred.doneUnsafe(this._terminal, Effect.succeed(event));
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
    if (this.terminalState !== 'open') return false;
    this.terminalState = 'claimed';
    return true;
  }

  get parentStreamId(): StreamTabId {
    return this._parentStreamId;
  }

  get isChildExecution(): boolean {
    return this._parentStreamId !== this.childStreamId;
  }

  /**
   * The parent this run's results route to, or `undefined` once the run is its
   * own parent (a root run, or a subagent promoted by {@link detach}). Derived
   * from `_parentStreamId` rather than mirrored into a second field, so detach
   * has one write and the two views can never disagree.
   */
  get deliveryTargetStreamId(): StreamTabId | undefined {
    return this.isChildExecution ? this._parentStreamId : undefined;
  }

  /** Promote this subagent to a top-level execution (detach from parent). */
  detach(): void {
    this._parentStreamId = this.childStreamId;
  }

  /**
   * True when this run is a live child whose results deliver to
   * `callerStreamId` — the one caller-ownership authorization check. Reads
   * the live parent edge, so a detached child answers false to its former
   * orchestrator.
   */
  isOwnedBy(callerStreamId: StreamTabId | null | undefined): boolean {
    return (
      callerStreamId != null &&
      this.isChildExecution &&
      this._parentStreamId === callerStreamId
    );
  }

  attachToolUseFlow(context: LiveToolUseFlowContext): void {
    if (this.category !== 'toolUse') {
      throw new Error('Only tool-use execution handles can attach tool flows.');
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
   * time a run suspends (`runToolUseFlow`'s `finally` detaches them on return)
   * while the handle stays tracked so a later resume can find it, so
   * `ExecutionRegistry.terminate()` reaches a suspended run through
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
  | 'executionId'
  | 'parentStreamId'
  | 'childStreamId'
  | 'identity'
  | 'category'
  | 'agentName'
  | 'startedAt'
  | 'trace'
  | 'result'
  | 'deliveryTargetStreamId'
  | 'interrupt'
>;
