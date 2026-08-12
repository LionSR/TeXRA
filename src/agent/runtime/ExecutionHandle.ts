/**
 * Live agent execution handle and terminal settlement.
 *
 * A handle owns one run's identity, its live control surfaces (interrupt,
 * tool-use flow, execution lease), and its exactly-once terminal settlement.
 * Termination policy lives with the owning registry.
 */

import pDefer from 'p-defer';

import type { AgentTrace, ResultEvent } from '@agent/trace';
import type { OwnedExecutionLeaseScope } from '@agent/storage/executionLease';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ToolUseFlowContext } from '@agent/implementations/flows/tooluse/runToolUseFlow';
import {
  runIdentityName,
  type ExecutionId,
  type RunIdentity,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import type { AgentCategory } from '@shared/schemas/agent';
import { onAbort } from '@utils/core';

export interface ExecutionStatusInfo {
  status: StreamPhase | 'unknown';
  elapsed: string | null;
}

/**
 * The run's immutable birth facts, the same values `run.start` publishes and
 * `registerExecution` persists. `category` is the launch-time in-memory
 * config's execution mode — never re-read from a persisted record or a
 * display projection.
 */
export interface ExecutionRun {
  readonly streamId: StreamTabId;
  readonly executionId: ExecutionId;
  readonly identity: RunIdentity;
  readonly category: AgentCategory;
}

/** Live run-owned capability that can receive a user stop request. */
export interface ExecutionInterruptHandler {
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
  | { readonly state: 'parked'; readonly teardown: () => void | Promise<void> }
  | { readonly state: 'terminating'; readonly completion: Promise<void> };

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
 * instead of silently diverging: the nested `session`/`modelHandler` views are
 * `Pick`s of the flow context's own types, and the method members are picked
 * through directly. `runToolUseFlow`'s context is deliberately richer (it owns
 * the live `ToolUseSessionLifecycle` and the full `RunModelHandler`); the
 * handle keeps only what a consumer of an attached run needs.
 *
 * {@link AgentExecutionHandle.interrupt} falls back to this context's
 * `interrupt()` when no explicit {@link ExecutionInterruptHandler} is
 * attached. Native child-run strategies use it to delegate a
 * child-run-loop-level interrupt into an in-flight tool-use turn. A live
 * `flowContext` is attached via `attachToolUseFlow` for the duration of one
 * turn and knows how to cancel the in-progress model/tool round.
 */
export type LiveToolUseFlowContext = {
  readonly ownerSession?: SessionHandle;
  readonly session: Pick<ToolUseFlowContext['session'], 'appendFollowUp'>;
  readonly modelHandler: Pick<
    ToolUseFlowContext['modelHandler'],
    'supportsManualCompaction'
  >;
} & Pick<
  ToolUseFlowContext,
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
export class AgentExecutionHandle {
  readonly startedAt = Date.now();
  private _parentStreamId: StreamTabId;
  private interruptHandler?: ExecutionInterruptHandler;
  private toolUseFlowContext?: LiveToolUseFlowContext;
  private detachToolUseAbortListener?: () => void;
  private suspension?: RunSuspension;
  private _executionLeaseLost = false;
  private executionLeaseScope?: OwnedExecutionLeaseScope;

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
   * execution is untracked. Always resolves — never rejects — so a consumer-less
   * failed run cannot produce an unhandled rejection. SDK consumers awaiting a
   * specific run's outcome use this; the host-wide stream is `session.onResult`.
   */
  private readonly _deferred = pDefer<ResultEvent>();
  readonly result = this._deferred.promise;
  private terminalState: TerminalState = 'open';

  constructor(
    /**
     * The run's birth facts, the same object its `run.start` published and its
     * terminal `result` reports. Held whole rather than copied field by field,
     * so the handle and the event plane cannot describe the run differently.
     */
    readonly run: ExecutionRun,
    parentStreamId: StreamTabId,
    /** The run's discriminated-event channel, for run-scoped subscribers. */
    readonly trace?: AgentTrace,
  ) {
    this._parentStreamId = parentStreamId;
  }

  get executionId(): ExecutionId {
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
    this._deferred.resolve(event);
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

  attachToolUseFlow(
    context: LiveToolUseFlowContext,
    signal?: AbortSignal,
  ): void {
    if (this.category !== 'toolUse') {
      throw new Error('Only tool-use execution handles can attach tool flows.');
    }
    this.detachToolUseAbortListener?.();
    this.toolUseFlowContext = context;
    if (!signal) return;

    this.detachToolUseAbortListener = onAbort(signal, () =>
      context.interrupt(),
    );
  }

  detachToolUseFlow(context?: LiveToolUseFlowContext): void {
    if (context !== undefined && this.toolUseFlowContext !== context) return;
    this.detachToolUseAbortListener?.();
    this.detachToolUseAbortListener = undefined;
    this.toolUseFlowContext = undefined;
  }

  getToolUseFlow(): LiveToolUseFlowContext | undefined {
    return this.toolUseFlowContext;
  }

  attachInterruptHandler(handler: ExecutionInterruptHandler): () => void {
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

  markExecutionLeaseLost(): void {
    this._executionLeaseLost = true;
  }

  get executionLeaseLost(): boolean {
    return this._executionLeaseLost;
  }

  /** Bind deferred handle-owned work to the lease generation that created it. */
  attachExecutionLeaseScope(scope: OwnedExecutionLeaseScope): void {
    this.executionLeaseScope = scope;
  }

  /** Re-enter the creating lease generation from an external lifecycle call. */
  runWithExecutionLease<T>(operation: () => T | Promise<T>): T | Promise<T> {
    // Some in-memory/embedder runs deliberately have no durable lease. Their
    // storage writes still pass through the execution-store write fence.
    return this.executionLeaseScope
      ? this.executionLeaseScope(operation)
      : operation();
  }

  /**
   * Interrupt this handle's attached background OS process, if any — the
   * case shutdown drain needs, distinct from `interrupt()`'s general stop
   * (which also covers a loop-level or in-flight-turn interrupt handler that
   * must stay untouched on shutdown so restart recovery can find it). A
   * background bash run (`BashBackgroundSession`, see `tools/bash.ts`) is the
   * only handler that currently sets `ownsBackgroundProcess`. Returns whether
   * a background-process interrupt handler was attached and interrupted.
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
  suspend(teardown: () => void | Promise<void>): void {
    this.suspension = { state: 'parked', teardown };
  }

  /** True once a stop claimed this suspended run and its teardown began. */
  get suspendedTerminationStarted(): boolean {
    return this.suspension?.state === 'terminating';
  }

  /**
   * Claim the terminal outcome of a run parked at WAITING and start its
   * teardown, returning the teardown's completion. Returns undefined when this
   * handle never parked, when a stop already claimed it, or when a
   * `finalizeRunTerminal` already claimed the run's terminal outcome. The whole
   * transition is synchronous, so a stop and a concurrent finalize of the same
   * handle cannot both proceed.
   */
  beginSuspendedTermination(): Promise<void> | undefined {
    if (this.suspension?.state !== 'parked') return undefined;
    if (!this.claimTerminalFinalize()) return undefined;
    const { teardown } = this.suspension;
    const completion = (async (): Promise<void> => {
      await teardown();
    })();
    // The registry normally awaits this before terminal persistence. Retain a
    // rejection handler for the lease-loss branch, which intentionally skips
    // durable finalization but must not create an unhandled rejection.
    void completion.catch(() => undefined);
    this.suspension = { state: 'terminating', completion };
    return completion;
  }
}

export type AgentRunHandle = Pick<
  AgentExecutionHandle,
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

/**
 * True when the handle is a child of parentStreamId (not the parent itself).
 */
export function isChildExecution(
  handle: AgentExecutionHandle,
  parentStreamId: StreamTabId,
): boolean {
  if (handle.parentStreamId !== parentStreamId) return false;
  return handle.isChildExecution;
}
