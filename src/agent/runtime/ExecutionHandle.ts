/**
 * Polymorphic execution handles.
 *
 * Replaces data-oriented maps with handles that know how to report status and
 * describe themselves. Termination policy lives with the owning registry.
 */

import pDefer from 'p-defer';

import type { AgentTrace, ResultEvent } from '@agent/trace';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { FollowUpQueueInput } from '@agent/followUp/FollowUpQueue';
import {
  STREAM_STATUS,
  streamStatusesWithTrait,
  type StreamTabId,
} from '@shared/schemas';
import type { AgentCategory } from '@shared/schemas/agent';
import type { RunCoordinators } from './RunContext';

export interface ExecutionStatusInfo {
  status: string;
  elapsed: string | null;
}

/**
 * Statuses that represent a live execution (running, transitioning, or
 * paused). This is exactly the `inFlight` trait — derived from the shared
 * trait table rather than re-declared.
 */
export const ACTIVE_STATUSES: ReadonlySet<string> =
  streamStatusesWithTrait('inFlight');

export interface ExecutionHandle {
  readonly executionId: string;
  readonly parentStreamId: StreamTabId;
  readonly category: AgentCategory | 'process';
  readonly agentName: string;
  readonly startedAt: number;
  readonly runtimeHost: AgentRuntimeHost;
}

export interface LiveToolUseFlowContext {
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
  private toolUseFlowContext?: LiveToolUseFlowContext;
  private waitingCleanups?: Set<() => void>;

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

  constructor(
    readonly executionId: string,
    parentStreamId: StreamTabId,
    readonly childStreamId: StreamTabId,
    readonly agentName: string,
    readonly category: AgentCategory,
    readonly runtimeHost: AgentRuntimeHost,
    readonly coordinators?: RunCoordinators,
    /** The run's discriminated-event channel, for run-scoped subscribers. */
    readonly trace?: AgentTrace,
  ) {
    this._parentStreamId = parentStreamId;
    this._deliveryTargetStreamId =
      parentStreamId === childStreamId ? undefined : parentStreamId;
  }

  /** Settle {@link result} with the terminal outcome (idempotent). */
  settleResult(event: ResultEvent): void {
    this._deferred.resolve(event);
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

  /** Promote this subagent to a top-level execution (detach from parent). */
  detach(): void {
    this._deliveryTargetStreamId = undefined;
    this._parentStreamId = this.childStreamId;
  }

  attachToolUseFlow(context: LiveToolUseFlowContext): void {
    if (this.category !== 'toolUse') {
      throw new Error('Only tool-use execution handles can attach tool flows.');
    }
    this.toolUseFlowContext = context;
  }

  detachToolUseFlow(context?: LiveToolUseFlowContext): void {
    if (context !== undefined && this.toolUseFlowContext !== context) return;
    this.toolUseFlowContext = undefined;
  }

  getToolUseFlow(): LiveToolUseFlowContext | undefined {
    return this.toolUseFlowContext;
  }

  /**
   * Register a teardown callback for when this handle is torn down while
   * suspended at WAITING — the live tool-use session and interrupt
   * registration are already gone by then (`runToolUseFlow`'s `finally`
   * unregisters them unconditionally on return, while the handle itself stays
   * tracked so a later resume can find it). `ExecutionRegistry.terminate()`
   * runs these instead of the (now absent) live interrupt when a stop/kill
   * targets a suspended subagent. Multiple independent owners (the run
   * lifecycle, a native subagent delivery strategy) may each register their
   * own teardown.
   */
  registerWaitingCleanup(cleanup: () => void): void {
    (this.waitingCleanups ??= new Set()).add(cleanup);
  }

  /**
   * Drop every registered waiting-cleanup without running it. The run
   * lifecycle calls this on every non-WAITING terminal path: owners may
   * pre-register from `onBeforeWaiting` before the suspension is confirmed,
   * and a flow that continues past the wait (queued follow-up) or errors out
   * must not leave a stale cleanup that `ExecutionRegistry.terminate()` could
   * mistake for a suspended handle during normal teardown.
   */
  clearWaitingCleanup(): void {
    this.waitingCleanups = undefined;
  }

  /**
   * Run and clear every registered waiting-cleanup callback.
   * Returns whether any callback was registered (and thus ran).
   */
  runWaitingCleanup(): boolean {
    const cleanups = this.waitingCleanups;
    if (!cleanups || cleanups.size === 0) return false;
    this.waitingCleanups = undefined;
    for (const cleanup of cleanups) cleanup();
    return true;
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
