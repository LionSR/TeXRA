/**
 * Polymorphic execution handles.
 *
 * Replaces data-oriented maps with handles that know how to report status and
 * describe themselves. Termination policy lives with the owning registry.
 */

import pDefer from 'p-defer';

import type { AgentTrace, ResultEvent } from '@agent/trace';
import type { OwnedExecutionLeaseScope } from '@agent/storage/executionLease';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
import {
  type ExecutionStatus,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import type { AgentCategory } from '@shared/schemas/agent';

export interface ExecutionStatusInfo {
  status: StreamPhase | ExecutionStatus | 'unknown';
  elapsed: string | null;
}

export interface ExecutionHandle {
  readonly executionId: string;
  readonly parentStreamId: StreamTabId;
  readonly category: AgentCategory;
  readonly agentName: string;
  readonly startedAt: number;
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

export interface LiveToolUseFlowContext {
  readonly ownerSession?: SessionHandle;
  readonly session: {
    appendFollowUp(followUp: FollowUpQueueInput): void;
  };
  readonly modelHandler: {
    readonly supportsManualCompaction: boolean;
  };

  requestImmediateCompaction(): void;
  modelSwitchDisabledReason(model: string): string | undefined;
  switchModel(model: string): Promise<void>;
  /**
   * Interrupt the live turn. Native child-run strategies use this to
   * delegate a child-run-loop-level interrupt into an in-flight tool-use
   * turn. A live `flowContext` is attached via `attachToolUseFlow` for the
   * duration of one turn and knows how to cancel the in-progress model/tool
   * round.
   */
  interrupt(): void;
}

/**
 * Handle for agent-based executions (workflow or toolUse subagents).
 * When `parentStreamId` differs from `childStreamId`, the handle represents
 * a subagent whose parent is an orchestrator.
 */
export class AgentExecutionHandle implements ExecutionHandle {
  readonly startedAt = Date.now();
  private _parentStreamId: StreamTabId;
  private interruptHandler?: ExecutionInterruptHandler;
  private toolUseFlowContext?: LiveToolUseFlowContext;
  private acceptsPendingInterrupt = false;
  private pendingInterrupt = false;
  private suspension?: RunSuspension;
  private _executionLeaseLost = false;
  private executionLeaseScope?: OwnedExecutionLeaseScope;

  /** Stable tool name for UI identification (e.g. "bash", "codex"). */
  toolName?: string;

  /**
   * Workflow-script phase owning this run, when it is an `agent()` grandchild
   * of a workflow-script run. Same mutable display-field slot as
   * {@link toolName}, and set the same way: assigned between construction and
   * `track()`, so the first roster emission already carries it.
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
  private _settled = false;
  private _finalizeClaimed = false;

  constructor(
    readonly executionId: string,
    parentStreamId: StreamTabId,
    readonly childStreamId: StreamTabId,
    readonly agentName: string,
    readonly category: AgentCategory,
    /** The run's discriminated-event channel, for run-scoped subscribers. */
    readonly trace?: AgentTrace,
  ) {
    this._parentStreamId = parentStreamId;
  }

  /** Settle {@link result} with the terminal outcome (idempotent). */
  settleResult(event: ResultEvent): void {
    this._settled = true;
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
    if (this._finalizeClaimed || this._settled) return false;
    this._finalizeClaimed = true;
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

  /** Whether lifecycle startup must preserve an already-cancelled status. */
  get hasPendingInterrupt(): boolean {
    return this.pendingInterrupt;
  }

  /** Promote this subagent to a top-level execution (detach from parent). */
  detach(): void {
    this._parentStreamId = this.childStreamId;
  }

  /** Allow a stop request to arrive between lifecycle tracking and setup. */
  enablePendingInterrupt(): void {
    this.acceptsPendingInterrupt = true;
  }

  /** Discard an undeliverable pre-attach stop when the runner exits. */
  closePendingInterruptWindow(): void {
    this.acceptsPendingInterrupt = false;
    this.pendingInterrupt = false;
  }

  attachToolUseFlow(context: LiveToolUseFlowContext): void {
    if (this.category !== 'toolUse') {
      throw new Error('Only tool-use execution handles can attach tool flows.');
    }
    this.acceptsPendingInterrupt = false;
    this.toolUseFlowContext = context;
    if (this.pendingInterrupt) {
      this.pendingInterrupt = false;
      context.interrupt();
    }
  }

  detachToolUseFlow(context?: LiveToolUseFlowContext): void {
    if (context !== undefined && this.toolUseFlowContext !== context) return;
    this.toolUseFlowContext = undefined;
  }

  getToolUseFlow(): LiveToolUseFlowContext | undefined {
    return this.toolUseFlowContext;
  }

  attachInterruptHandler(handler: ExecutionInterruptHandler): () => void {
    this.acceptsPendingInterrupt = false;
    this.interruptHandler = handler;
    if (this.pendingInterrupt) {
      this.pendingInterrupt = false;
      handler.interrupt();
    }
    return () => this.detachInterruptHandler(handler);
  }

  detachInterruptHandler(handler?: ExecutionInterruptHandler): void {
    if (handler !== undefined && this.interruptHandler !== handler) return;
    this.interruptHandler = undefined;
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
    if (!this.acceptsPendingInterrupt) return false;
    this.pendingInterrupt = true;
    return true;
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
  | 'category'
  | 'agentName'
  | 'startedAt'
  | 'trace'
  | 'result'
  | 'deliveryTargetStreamId'
  | 'interrupt'
>;

/** True when the handle is a child of parentStreamId (not the parent itself). */
export function isChildExecution(
  handle: ExecutionHandle,
  parentStreamId: StreamTabId,
): boolean {
  if (handle.parentStreamId !== parentStreamId) return false;
  return handle instanceof AgentExecutionHandle && handle.isChildExecution;
}
