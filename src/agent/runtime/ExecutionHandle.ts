/**
 * Polymorphic execution handles.
 *
 * Replaces data-oriented maps with handles that know how to report status and
 * describe themselves. Termination policy lives with the owning registry.
 */

import pDefer from 'p-defer';

import type { AgentTrace, ResultEvent } from '@agent/trace';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
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
  readonly category: AgentCategory | 'process';
  readonly agentName: string;
  readonly startedAt: number;
  readonly runtimeHost: AgentRuntimeHost;
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

export interface LiveToolUseFlowContext {
  readonly ownerSession?: SessionHandle;
  readonly session: {
    appendFollowUp(followUp: FollowUpQueueInput): void;
  };
  readonly modelHandler: {
    readonly supportsManualCompaction: boolean;
  };
  readonly runtimeHost?: AgentRuntimeHost;

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
  private _deliveryTargetStreamId: StreamTabId | undefined;
  private interruptHandler?: ExecutionInterruptHandler;
  private toolUseFlowContext?: LiveToolUseFlowContext;
  private acceptsPendingInterrupt = false;
  private pendingInterrupt = false;
  private waitingCleanups?: Set<() => void | Promise<void>>;
  private waitingCleanupCompletion: Promise<void> = Promise.resolve();
  private _executionLeaseLost = false;

  /** Stable tool name for UI identification (e.g. "bash", "codex"). */
  toolName?: string;

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
    readonly runtimeHost: AgentRuntimeHost,
    /** The run's discriminated-event channel, for run-scoped subscribers. */
    readonly trace?: AgentTrace,
  ) {
    this._parentStreamId = parentStreamId;
    this._deliveryTargetStreamId =
      parentStreamId === childStreamId ? undefined : parentStreamId;
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
   * handle) cannot both win. Also refuses when a terminal result already
   * settled outside the finalizer (`terminateWaitingHandle` settles directly),
   * so a late finalize cannot publish a second, contradictory result.
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
    return this._deliveryTargetStreamId !== undefined;
  }

  get deliveryTargetStreamId(): StreamTabId | undefined {
    return this._deliveryTargetStreamId;
  }

  /** Whether lifecycle startup must preserve an already-cancelled status. */
  get hasPendingInterrupt(): boolean {
    return this.pendingInterrupt;
  }

  /** Promote this subagent to a top-level execution (detach from parent). */
  detach(): void {
    this._deliveryTargetStreamId = undefined;
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
   * Register a teardown callback for when this handle is torn down while
   * suspended at WAITING — the live tool-use session and interrupt
   * context is already gone by then (`runToolUseFlow`'s `finally` detaches
   * it unconditionally on return, while the handle itself stays tracked so a
   * later resume can find it). `ExecutionRegistry.terminate()`
   * runs these instead of the (now absent) live interrupt when a stop/kill
   * targets a suspended subagent that has no loop-level interrupt handler
   * covering the gap (see `childRunLoop.ts`'s own whole-lifetime
   * handler, which is the primary path for a loop-driven child).
   */
  registerWaitingCleanup(cleanup: () => void | Promise<void>): void {
    (this.waitingCleanups ??= new Set()).add(cleanup);
  }

  /**
   * Drop every registered waiting-cleanup without running it. The run
   * lifecycle calls this on every non-WAITING terminal path: a flow that
   * continues past the wait (queued follow-up, root mode only) or errors out
   * must not leave a stale cleanup that `ExecutionRegistry.terminate()` could
   * mistake for a suspended handle during normal teardown.
   */
  clearWaitingCleanup(): void {
    this.waitingCleanups = undefined;
    this.waitingCleanupCompletion = Promise.resolve();
  }

  /**
   * Run and clear every registered waiting-cleanup callback.
   * Returns whether any callback was registered (and thus ran).
   */
  runWaitingCleanup(): boolean {
    const cleanups = this.waitingCleanups;
    if (!cleanups || cleanups.size === 0) return false;
    this.waitingCleanups = undefined;
    this.waitingCleanupCompletion = Promise.all(
      [...cleanups].map(async (cleanup) => cleanup()),
    ).then(() => undefined);
    // The registry normally awaits this before terminal persistence. Retain a
    // rejection handler for the lease-loss branch, which intentionally skips
    // durable finalization but must not create an unhandled rejection.
    void this.waitingCleanupCompletion.catch(() => undefined);
    return true;
  }

  waitForWaitingCleanup(): Promise<void> {
    return this.waitingCleanupCompletion;
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
  | 'runtimeHost'
  | 'trace'
  | 'result'
  | 'deliveryTargetStreamId'
  | 'registerWaitingCleanup'
  | 'interrupt'
>;

/**
 * Handle for background bash processes.
 * No `childStreamId` — processes don't have their own stream.
 */
export class ProcessExecutionHandle implements ExecutionHandle {
  readonly category = 'process' as const;
  readonly startedAt = Date.now();

  /** Ephemeral temp file paths for live output (set after construction, cleared on completion). */
  outputPaths?: { readonly stdout: string; readonly stderr: string };

  /** Stable tool name for UI identification (e.g. "bash", "codex"). */
  toolName?: string;

  constructor(
    readonly executionId: string,
    readonly parentStreamId: StreamTabId,
    readonly agentName: string,
    private readonly killFn: () => boolean,
    readonly runtimeHost: AgentRuntimeHost,
  ) {}

  terminate(): boolean {
    return this.killFn();
  }
}

/** True when the handle is a child of parentStreamId (not the parent itself). */
export function isChildExecution(
  handle: ExecutionHandle,
  parentStreamId: StreamTabId,
): boolean {
  if (handle.parentStreamId !== parentStreamId) return false;
  if (handle instanceof AgentExecutionHandle) {
    return handle.isChildExecution;
  }
  return true;
}
