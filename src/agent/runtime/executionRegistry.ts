/**
 * Handle-based execution registry.
 *
 * Manages agent execution handles and provides registration, lookup, change
 * notification, and subagent lineage tracking in a single module.
 */

import { createChannelTrace, type ResultEvent } from '@agent/trace';
import {
  ExecutionLeaseLostError,
  markOwnedExecutionLeaseUndurable,
} from '@agent/storage/executionLease';
import { persistTerminalExecution } from '@agent/storage/terminalPersistence';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionApprovals } from '@agent/runtime/streamApprovalQueue';
import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type ActiveChildInfo,
  type ExecutionId,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import {
  isActivePhase,
  isInFlightPhase,
  isTerminalOutcomePhase,
} from '@shared/streams/streamStatus';
import { formatDuration, onAbort } from '@utils/core';
import { createListenerSet, type ListenerSet } from '@utils/core/listenerSet';
import {
  isChildExecution,
  type AgentExecutionHandle,
  type ExecutionStatusInfo,
  type LiveToolUseFlowContext,
} from './ExecutionHandle';
import { ExecutionInteractionOwnership } from './executionInteractionOwnership';
import { SessionEventHub } from './SessionEventHub';

const logger = createChannelTrace('executionRegistry');

/** Child policy shared by `kill()` and `stopAgentStream()`. */
export interface ExecutionStopOptions {
  readonly detachActiveChildren?: boolean;
}

/**
 * A child loop that has started synchronously but whose first run handle is
 * still being constructed.
 */
export interface ChildExecutionActivation {
  readonly executionId: ExecutionId;
  readonly parentStreamId: StreamTabId;
  readonly childStreamId: StreamTabId;
}

interface TerminateOptions {
  readonly cascadeChildren?: boolean;
}

export type ToolUseFollowUpQueueReason =
  'resuming' | 'waiting' | 'children_running';

export type ToolUseFollowUpTarget =
  | {
      readonly kind: 'active';
      readonly context: LiveToolUseFlowContext;
    }
  | {
      readonly kind: 'queue';
      readonly reason: ToolUseFollowUpQueueReason;
    }
  | {
      readonly kind: 'no_session';
      readonly streamStatus: StreamPhase | undefined;
    };

export type ManualCompactionRequestResult =
  | {
      readonly kind: 'requested';
      readonly streamId: StreamTabId;
      readonly session?: SessionHandle;
    }
  | {
      readonly kind: 'unsupported';
      readonly streamId: StreamTabId;
    }
  | {
      readonly kind: 'no_active_tool_use';
      readonly streamId?: StreamTabId;
    };

/**
 * A caller bringing its own status machine must bring the hub that machine
 * publishes on: the registry subscribes to status facts there, and a second hub
 * would leave that subscription listening where nothing is ever published.
 */
interface ExecutionRegistryInit {
  readonly streamStatus: StreamStatusMachine;
  readonly events: SessionEventHub;
  readonly approvals?: SessionApprovals;
  readonly publishResult?: (event: ResultEvent, streamId: StreamTabId) => void;
  /**
   * The session's one exit choreography (`SessionHandle.releaseExecutionLease`)
   * — required so no construction path can silently release a lease without
   * draining the session's durable writers first.
   */
  readonly releaseRootExecutionLease: (
    executionId: ExecutionId,
  ) => Promise<void>;
}

/**
 * Session-owned registry of active executions and their change listeners.
 *
 * One instance belongs to each {@link SessionHandle}, which binds it to that
 * session's event hub, approvals, and lease-release boundary.
 */
export class ExecutionRegistry {
  /**
   * Which host-interaction generation owns each live execution. Session-wide so
   * generations of one host hand ownership over without inheriting each
   * other's runs; the CLI chat controller is its only writer.
   */
  readonly interactionOwnership = new ExecutionInteractionOwnership(this);
  private readonly handles = new Map<string, AgentExecutionHandle>();
  private disposed = false;
  private readonly disposeStatusSubscription: () => void;
  private readonly streamStatus: StreamStatusMachine;
  private readonly events: SessionEventHub;
  private readonly approvals: SessionApprovals | undefined;
  /**
   * Publishes a synthesized terminal `result` event to the owning session's
   * `onResult` channel — the same forwarding `SessionHandle.attachRunTrace`
   * does for a live run's own trace, injected here because
   * `terminateWaitingHandle` produces its `result` event *after* the
   * suspended run's own trace has already been disposed (see there).
   */
  private readonly publishResult:
    ((event: ResultEvent, streamId: StreamTabId) => void) | undefined;
  private readonly releaseRootExecutionLease: (
    executionId: ExecutionId,
  ) => Promise<void>;
  private readonly listeners = new Map<
    string,
    Set<(handle: AgentExecutionHandle | undefined) => void>
  >();
  private readonly registrationListeners: ListenerSet<
    (executionId: string, handle: AgentExecutionHandle | undefined) => void
  > = createListenerSet();
  private readonly childActivations = new Map<
    string,
    ChildExecutionActivation
  >();
  private readonly childActivationListeners: ListenerSet<
    (activation: ChildExecutionActivation, active: boolean) => void
  > = createListenerSet();

  constructor(options: ExecutionRegistryInit) {
    this.events = options.events;
    this.streamStatus = options.streamStatus;
    this.approvals = options.approvals;
    this.publishResult = options.publishResult;
    this.releaseRootExecutionLease = options.releaseRootExecutionLease;
    // Notify waiters and refresh UI badges when stream status changes
    // (e.g. RUNNING → WAITING). SessionEventHub dispatch is synchronous, so
    // bookkeeping retains the status machine subscription's original ordering.
    this.disposeStatusSubscription = options.events.subscribeStatus(
      ({ streamId }) => {
        for (const [executionId, handle] of this.handles) {
          if (handle.childStreamId === streamId) {
            this.notifyWaiters(executionId);
            if (handle.isChildExecution) {
              this.emitChildActivity(handle.parentStreamId);
            }
            break;
          }
        }
      },
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeStatusSubscription();
    const executionIds = [...this.handles.keys()];
    this.handles.clear();
    for (const executionId of executionIds) {
      this.notifyRegistrationListeners(executionId, undefined);
      this.notifyWaiters(executionId);
    }
    for (const activation of this.childActivations.values()) {
      this.notifyChildActivationListeners(activation, false);
    }
    this.childActivations.clear();
    this.listeners.clear();
    this.registrationListeners.clear();
    this.childActivationListeners.clear();
  }

  /** Register an execution handle. */
  track(handle: AgentExecutionHandle): void {
    this.assertActive();
    const previous = this.handles.get(handle.executionId);
    if (previous && previous.suspendedTerminationStarted) {
      // A resumed lifecycle can replace its suspended predecessor while the
      // predecessor's asynchronous teardown is still in progress. The
      // stop already claimed that execution, so carry it across the ownership
      // handoff instead of allowing the successor to revive the run.
      handle.interrupt();
    }
    this.handles.set(handle.executionId, handle);
    if (handle.isChildExecution) {
      this.emitChildActivity(handle.parentStreamId);
      this.emitParentStreamUpdate({
        childStreamId: handle.childStreamId,
        parentStreamId: handle.parentStreamId,
      });
    }
    this.notifyRegistrationListeners(handle.executionId, handle);
    this.releaseChildActivation(handle.executionId);
    this.notifyWaiters(handle.executionId);
  }

  /**
   * Register an agent execution and, when requested, publish its initial
   * stream status through the registry-owned status store.
   */
  trackAgentExecution(
    handle: AgentExecutionHandle,
    options: { readonly status?: StreamPhase } = {},
  ): void {
    this.assertActive();
    if (options.status) {
      const previousStatus = this.streamStatus.get(handle.childStreamId);
      const cause =
        options.status === STREAM_PHASE.RUNNING &&
        isTerminalOutcomePhase(previousStatus)
          ? 'resume'
          : 'lifecycle';
      this.streamStatus.transition(handle.childStreamId, options.status, cause);
    }
    this.track(handle);
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('Cannot register execution work after session disposal.');
    }
  }

  /**
   * Publish an in-flight agent status through the registry-owned status store.
   * Explicit user stops win over loop transitions, and stale handles cannot
   * revive an execution that has already been untracked.
   */
  updateAgentExecutionStatus(
    handle: AgentExecutionHandle,
    status: StreamPhase,
  ): boolean {
    if (this.handles.get(handle.executionId) !== handle) return false;
    const previous = this.streamStatus.get(handle.childStreamId);
    let cause: 'wait' | 'resume' | 'lifecycle';
    if (status === STREAM_PHASE.WAITING) {
      cause = 'wait';
    } else if (
      status === STREAM_PHASE.RUNNING &&
      previous === STREAM_PHASE.WAITING
    ) {
      cause = 'resume';
    } else {
      cause = 'lifecycle';
    }
    return this.streamStatus.transition(handle.childStreamId, status, cause);
  }

  /** Remove an execution handle and notify waiters. */
  untrack(executionId: string): void {
    const handle = this.handles.get(executionId);
    if (!handle) {
      this.notifyWaiters(executionId);
      return;
    }

    this.untrackHandle(handle);
  }

  /** Remove `handle` only if it is still the current registration. */
  private untrackIfCurrent(handle: AgentExecutionHandle): boolean {
    if (this.handles.get(handle.executionId) !== handle) return false;
    this.untrackHandle(handle);
    return true;
  }

  private untrackHandle(handle: AgentExecutionHandle): void {
    this.handles.delete(handle.executionId);
    this.notifyRegistrationListeners(handle.executionId, undefined);
    this.notifyWaiters(handle.executionId);
    if (handle.isChildExecution) {
      this.emitChildActivity(handle.parentStreamId);
    }
  }

  getHandle(executionId: string): AgentExecutionHandle | undefined {
    return this.handles.get(executionId);
  }

  getStatus(
    handle: AgentExecutionHandle,
  ): ExecutionStatusInfo & { status: StreamPhase } {
    const status =
      this.streamStatus.get(handle.childStreamId) ?? STREAM_PHASE.RUNNING;

    if (!isActivePhase(status)) {
      return { status, elapsed: null };
    }

    return {
      status,
      elapsed: formatDuration(Date.now() - handle.startedAt),
    };
  }

  getAgentHandleByStream(
    streamId: StreamTabId,
  ): AgentExecutionHandle | undefined {
    for (const handle of this.handles.values()) {
      if (handle.childStreamId === streamId) {
        return handle;
      }
    }
    return undefined;
  }

  getAgentHandles(): AgentExecutionHandle[] {
    return [...this.handles.values()];
  }

  getToolUseFlowContext(
    streamId: StreamTabId,
  ): LiveToolUseFlowContext | undefined {
    return this.getAgentHandleByStream(streamId)?.getToolUseFlow();
  }

  /**
   * Request manual compaction from the active tool-use flow, if one exists.
   *
   * Hosts own the user-facing message, but the registry owns the live-flow
   * lookup and model capability test so CLI and extension do not rederive the
   * same runtime facts.
   */
  requestManualCompaction(
    streamId: StreamTabId | undefined,
  ): ManualCompactionRequestResult {
    const context = streamId ? this.getToolUseFlowContext(streamId) : undefined;
    if (!streamId || !context) {
      return {
        kind: 'no_active_tool_use',
        ...(streamId && { streamId }),
      };
    }
    if (!context.modelHandler.supportsManualCompaction) {
      return { kind: 'unsupported', streamId };
    }

    context.requestImmediateCompaction();
    return {
      kind: 'requested',
      streamId,
      ...(context.ownerSession && { session: context.ownerSession }),
    };
  }

  /**
   * Decide how a tool-use follow-up should be admitted from one registry-owned
   * snapshot of stream status, active flow context, and child executions.
   */
  getToolUseFollowUpTarget(streamId: StreamTabId): ToolUseFollowUpTarget {
    const status = this.streamStatus.get(streamId);
    const hasActiveChildren = this.hasActiveChildren(streamId);

    if (status !== undefined && !isInFlightPhase(status)) {
      if (hasActiveChildren) {
        return { kind: 'queue', reason: 'children_running' };
      }
      return { kind: 'no_session', streamStatus: status };
    }

    const context = this.getToolUseFlowContext(streamId);
    if (context) return { kind: 'active', context };

    if (this.streamStatus.getSubstate(streamId) === STREAM_SUBSTATE.RESUMING) {
      return { kind: 'queue', reason: 'resuming' };
    }
    if (status === STREAM_PHASE.WAITING) {
      return { kind: 'queue', reason: 'waiting' };
    }
    if (hasActiveChildren) {
      return { kind: 'queue', reason: 'children_running' };
    }
    return { kind: 'no_session', streamStatus: status };
  }

  /** Terminate an execution via its handle. Returns true on success. */
  kill(executionId: string, options: ExecutionStopOptions = {}): boolean {
    const handle = this.handles.get(executionId);
    if (!handle) return false;
    const visited = new Set<string>();
    if (options.detachActiveChildren === true) {
      this.detachActiveChildren(handle.childStreamId);
    }
    const result = this.terminate(handle, visited, {
      cascadeChildren: options.detachActiveChildren !== true,
    });
    // Always notify waiters — even if terminate() returned false (e.g. PID not
    // yet assigned), callers blocking on this execution should be unblocked.
    this.notifyWaiters(executionId);
    return result;
  }

  getActiveIds(): string[] {
    return [...this.handles.keys()];
  }

  /**
   * Kill only background OS processes (bash, codex) without touching agent
   * stream status. Agent executions are left in RUNNING so restart recovery can
   * restore them to WAITING (resumable) if a flow record exists.
   *
   * Killing a background run's underlying OS process requires
   * `interruptBackgroundProcess()`, which only fires for a handle whose
   * attached interrupt handler declares itself as owning a live background
   * process, leaving every other `AgentExecutionHandle` (root/native-subagent
   * runs, loop-level interrupts) untouched (#8155).
   */
  killBackgroundProcesses(): void {
    for (const handle of this.handles.values()) {
      handle.interruptBackgroundProcess();
    }
  }

  /**
   * Wait for any change on an execution: status transition, kill, or
   * completion (untrack). Pass an AbortSignal for timeout cleanup.
   */
  waitForChange(executionId: string, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let detachAbort: () => void = () => {};
      const detachListener = this.addListener(executionId, () => {
        detachAbort();
        detachListener();
        resolve();
      });
      detachAbort = onAbort(signal, () => {
        detachListener();
        resolve();
      });
    });
  }

  /**
   * Wait for any of the given executions to change.
   * Resolves with the execution id that changed first (or '' on abort).
   */
  waitForAnyChange(
    executionIds: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      let resolved = false;
      let detachAbort: () => void = () => {};
      const detachListeners: Array<() => void> = [];

      const cleanup = (): void => {
        detachAbort();
        for (const detach of detachListeners) detach();
      };

      for (const id of executionIds) {
        detachListeners.push(
          this.addListener(id, () => {
            if (resolved) return;
            resolved = true;
            cleanup();
            resolve(id);
          }),
        );
      }

      detachAbort = onAbort(signal, () => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve('');
      });
    });
  }

  /** Interrupt all active subagents of a parent stream, including descendants. */
  private interruptActiveChildren(
    parentStreamId: StreamTabId,
    visited: Set<string>,
    options: TerminateOptions,
  ): void {
    for (const handle of this.handles.values()) {
      if (isChildExecution(handle, parentStreamId)) {
        this.terminate(handle, visited, options);
      }
    }
  }

  /**
   * Detach all active subagents from a parent, promoting them to top-level.
   * Subagents continue running independently and deliver results via the
   * follow-up queue. Called when stopping an orchestrator without killing
   * children.
   */
  detachActiveChildren(parentStreamId: StreamTabId): void {
    for (const handle of this.handles.values()) {
      if (!isChildExecution(handle, parentStreamId)) continue;
      this.approvals?.detachStreamFromParent(handle.childStreamId);
      handle.detach();
      this.emitParentStreamUpdate({
        childStreamId: handle.childStreamId,
        parentStreamId: null,
      });
    }
    this.emitChildActivity(parentStreamId);
  }

  /**
   * Stop a visible agent stream and apply the same child policy everywhere.
   *
   * Hosts should call this instead of reconstructing stop behavior from
   * child-interrupts, root interrupts, and stream-status writes.
   */
  stopAgentStream(
    streamId: StreamTabId,
    options: ExecutionStopOptions = {},
  ): void {
    const rootHandle = this.getAgentHandleByStream(streamId);
    // Shared across the child sweep and the root cascade so each execution in
    // the chain is interrupted exactly once.
    const visited = new Set<string>();

    if (options.detachActiveChildren === true) {
      this.detachActiveChildren(streamId);
    } else {
      this.interruptActiveChildren(streamId, visited, {
        cascadeChildren: true,
      });
    }

    const stopped = rootHandle
      ? this.terminate(rootHandle, visited, {
          cascadeChildren: options.detachActiveChildren !== true,
        })
      : false;
    // `terminate()` already publishes CANCELLED for a stream it owned; an
    // ownerless (or already-untracked) stream still needs the write. The
    // stream-status machine rejects the transition out of a terminal phase,
    // so a finished stream keeps its outcome.
    if (stopped) return;
    this.cancelStreamStatus(streamId);
  }

  /**
   * Add a persistent listener invoked on every change to `executionId` (status
   * transition, progress update, kill, untrack). Returns a disposer.
   *
   * The callback receives the current handle, or `undefined` once the
   * execution has been untracked (terminal event).
   */
  addListener(
    executionId: string,
    cb: (handle: AgentExecutionHandle | undefined) => void,
  ): () => void {
    let set = this.listeners.get(executionId);
    if (!set) {
      set = new Set();
      this.listeners.set(executionId, set);
    }
    set.add(cb);
    return () => {
      const s = this.listeners.get(executionId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.listeners.delete(executionId);
    };
  }

  /** Observe handle registrations, replacements, and removals across all ids. */
  addRegistrationListener(
    cb: (executionId: string, handle: AgentExecutionHandle | undefined) => void,
  ): () => void {
    return this.registrationListeners.add(cb);
  }

  /**
   * Retain lineage while a newly started child loop is constructing its first
   * execution handle. Tracking that handle promotes the activation
   * automatically; the returned disposer covers startup failure.
   */
  reserveChildActivation(activation: ChildExecutionActivation): () => void {
    this.assertActive();
    if (
      this.handles.has(activation.executionId) ||
      this.childActivations.has(activation.executionId)
    ) {
      return () => {};
    }
    this.childActivations.set(activation.executionId, activation);
    this.notifyChildActivationListeners(activation, true);
    return () =>
      this.releaseChildActivation(activation.executionId, activation);
  }

  /** Observe child-loop activation reservations and their release/promotion. */
  addChildActivationListener(
    cb: (activation: ChildExecutionActivation, active: boolean) => void,
  ): () => void {
    return this.childActivationListeners.add(cb);
  }

  private emitChildActivity(parentStreamId: StreamTabId): void {
    this.events.emit({
      scope: 'run',
      streamId: parentStreamId,
      event: {
        type: 'child.activity',
        parentStreamId,
        items: this.getActiveChildren(parentStreamId),
      },
    });
  }

  private emitParentStreamUpdate(payload: {
    readonly childStreamId: StreamTabId;
    readonly parentStreamId: StreamTabId | null;
  }): void {
    this.events.emit({
      scope: 'session',
      event: {
        type: 'setParentStream',
        payload: {
          childStreamId: payload.childStreamId,
          parentStreamId: payload.parentStreamId,
        },
      },
    });
  }

  /** Get active subagent children for a parent stream. */
  getActiveChildren(parentStreamId: StreamTabId): ActiveChildInfo[] {
    const result: ActiveChildInfo[] = [];
    for (const handle of this.handles.values()) {
      if (!isChildExecution(handle, parentStreamId)) continue;
      const { status, elapsed } = this.getStatus(handle);
      result.push({
        executionId: handle.executionId,
        identity: handle.identity,
        agentName: handle.agentName,
        status,
        startedAt: handle.startedAt,
        elapsed,
        childStreamId: handle.childStreamId,
        ...(handle.workflowPhase
          ? { workflowPhase: handle.workflowPhase }
          : {}),
      });
    }
    return result;
  }

  hasActiveChildren(parentStreamId: StreamTabId): boolean {
    for (const handle of this.handles.values()) {
      if (isChildExecution(handle, parentStreamId)) return true;
    }
    return false;
  }

  private terminate(
    handle: AgentExecutionHandle,
    visited: Set<string>,
    options: TerminateOptions,
  ): boolean {
    if (visited.has(handle.executionId)) return false;
    visited.add(handle.executionId);
    if (options.cascadeChildren === true) {
      this.interruptActiveChildren(handle.childStreamId, visited, options);
    }
    if (handle.interrupt()) {
      this.cancelStreamStatus(handle.childStreamId);
      return true;
    }
    // No live interrupt context: a native subagent suspended at WAITING has
    // already had its tool-use session disposed and interrupt handler detached
    // (runToolUseFlow's finally), while the handle stays tracked for resume
    // (runFlowWithLifecycle). Run the teardown it parked with instead of
    // silently no-oping the kill.
    return this.terminateWaitingHandle(handle);
  }

  /**
   * Tear down an `AgentExecutionHandle` parked at WAITING with no live
   * interrupt context, returning whether this stop claimed the run.
   *
   * The handle's own suspension is the single authority on both questions this
   * path used to cross-check: `runFlowWithLifecycle`'s WAITING branch is what
   * parks a handle, and `beginSuspendedTermination` claims the run's terminal
   * outcome and starts the teardown in one synchronous step. So a handle that
   * never parked (one merely between its own interrupt-handler detach and
   * untrack during normal teardown) and a run whose terminal outcome
   * `finalizeRunTerminal` already claimed both leave this a no-op, with no
   * `streamStatus` re-read: a stop can neither abandon a live run nor publish
   * a second outcome. That also covers the window
   * `resumeQueuedToolUseFromResumeData` opens by flipping the stream to
   * RUNNING/RESUMING before the resumed run installs its own context — the
   * suspended handle it replaces is still parked, so a stop landing there
   * still tears the stalled resume down.
   *
   * This path bypasses `runFlowWithLifecycle`'s own terminal handling (the
   * flow never resumes to produce one), so it publishes the terminal
   * `result`, settles `handle.result`, and persists the terminal status
   * itself — otherwise trace/session subscribers would miss the stop, a
   * consumer awaiting `handle.result` (F-2) would hang forever, and the
   * execution's history would keep a non-terminal status. Unlike
   * `finalizeRunTerminal`, no usage totals ride the event: the flow is
   * suspended, so there is no live usage monitor to read.
   *
   * `handle.trace` belongs to the turn that suspended this handle at WAITING,
   * and `runFlowWithLifecycle`'s own `finally` already disposed it (channel +
   * transcript + session bridge) the moment that turn returned — emitting on
   * it is a harmless best effort, not the real fix. `publishResult` (wired
   * from `SessionHandle.publishRunEvent`) reaches this session's
   * `onResult`/event-bus subscribers directly instead, so a user-initiated
   * stop of a suspended native subagent still surfaces a terminal event even
   * though the turn's own trace is already gone.
   */
  private terminateWaitingHandle(handle: AgentExecutionHandle): boolean {
    const teardown = handle.beginSuspendedTermination();
    if (!teardown) return false;
    const cancelledResult: ResultEvent = {
      type: 'result',
      outcome: RUN_OUTCOME.CANCELLED,
      executionId: handle.executionId,
      streamId: handle.childStreamId,
      agentName: handle.agentName,
      category: handle.category,
      isSubagent: handle.isChildExecution,
    };
    void this.finishWaitingTermination(handle, teardown, cancelledResult).catch(
      async (error: unknown) => {
        const recoveryFailures = [error];
        if (!(error instanceof ExecutionLeaseLostError)) {
          try {
            await handle.runWithExecutionLease(async () => {
              markOwnedExecutionLeaseUndurable(handle.executionId);
              const untracked = this.settleTerminal(handle, cancelledResult, {
                publish: false,
                untrackMode: 'ifCurrent',
              });
              if (untracked && !handle.isChildExecution) {
                await this.releaseRootExecutionLease(handle.executionId);
              }
            });
            logger.warn(
              'Waiting-execution termination failed; recovered under the execution lease',
              { data: { executionId: handle.executionId, recoveryFailures } },
            );
            return;
          } catch (recoveryError) {
            recoveryFailures.push(recoveryError);
          }
        }

        // A former generation owns only its private result. It must not mark,
        // release, untrack, or cancel a locally reacquired successor.
        try {
          handle.settleResult(cancelledResult);
        } catch (recoveryError) {
          recoveryFailures.push(recoveryError);
        }
        try {
          const untracked = this.untrackIfCurrent(handle);
          if (untracked) {
            this.cancelStreamStatus(handle.childStreamId);
          }
        } catch (recoveryError) {
          recoveryFailures.push(recoveryError);
        }
        logger.warn(
          'Waiting-execution termination failed; settled the run without durable finalization',
          { data: { executionId: handle.executionId, recoveryFailures } },
        );
      },
    );
    return true;
  }

  private async finishWaitingTermination(
    handle: AgentExecutionHandle,
    teardown: Promise<void>,
    cancelledResult: ResultEvent,
  ): Promise<void> {
    return await handle.runWithExecutionLease(async () => {
      try {
        await teardown;
      } catch (error) {
        // Transcript closure and terminal execution metadata are independent
        // durable facts. Preserve the failed artifact fence, but still give the
        // terminal status its own opportunity to reach disk.
        markOwnedExecutionLeaseUndurable(handle.executionId);
        logger.warn(
          'Waiting-execution cleanup failed; continuing terminal persistence',
          { data: { executionId: handle.executionId, error } },
        );
      }

      if (this.handles.get(handle.executionId) !== handle) {
        // `track` transfers the pending stop to a resumed successor. The old
        // handle still needs its private result settled, but it no longer owns
        // the shared stream, execution metadata, or lease.
        handle.settleResult(cancelledResult);
        return;
      }

      if (handle.executionLeaseLost) {
        logger.warn('Discarding a stopped waiting execution after lease loss', {
          data: { executionId: handle.executionId },
        });
        // Settle the in-memory result only: the former owner must not publish or
        // persist a terminal event, but this promise must resolve on every exit.
        this.settleTerminal(handle, cancelledResult, {
          publish: false,
          untrackMode: 'unconditional',
        });
        return;
      }

      // Cleanup closes the suspended run's transcript group. Publish the
      // terminal state only after that owned artifact is settled so every host
      // observes one coherent cancellation boundary.
      this.settleTerminal(handle, cancelledResult, {
        publish: true,
        untrackMode: 'unconditional',
      });

      try {
        await persistTerminalExecution({
          executionId: handle.executionId,
          outcome: RUN_OUTCOME.CANCELLED,
          flowRecord: 'delete',
          logger,
          failedMessage: 'Failed to finalize stopped waiting execution',
        });
      } finally {
        if (!handle.isChildExecution) {
          try {
            await this.releaseRootExecutionLease(handle.executionId);
          } catch (error) {
            logger.warn('Waiting-execution artifact flush failed', {
              data: { executionId: handle.executionId, error },
            });
          }
        }
      }
    });
  }

  /**
   * Owns the settle -> untrack -> cancel-stream ordering shared by the
   * waiting-termination arms so every arm settles the terminal envelope, drops
   * the handle from the registry, and cancels the stream in the same order.
   *
   * `publish` prepends the trace emit + `publishResult` fan-out used only by the
   * happy path, where cleanup has already closed the suspended run's transcript
   * group so hosts observe one coherent cancellation boundary. The
   * recovery/lease-lost arms settle the private result without republishing.
   *
   * `untrackMode` selects the registry drop: `'unconditional'` uses
   * `untrackHandle` (the caller has already confirmed this handle still owns the
   * slot) and always cancels; `'ifCurrent'` uses `untrackIfCurrent` and cancels
   * only when the drop actually removed this handle. The returned boolean
   * reports whether the handle was untracked (always true for `'unconditional'`)
   * so a caller can gate a lease release on it.
   */
  private settleTerminal(
    handle: AgentExecutionHandle,
    result: ResultEvent,
    opts: { publish: boolean; untrackMode: 'unconditional' | 'ifCurrent' },
  ): boolean {
    if (opts.publish) {
      handle.trace?.emit(result);
      this.publishResult?.(result, handle.childStreamId);
    }
    handle.settleResult(result);
    if (opts.untrackMode === 'ifCurrent') {
      const untracked = this.untrackIfCurrent(handle);
      if (untracked) {
        this.cancelStreamStatus(handle.childStreamId);
      }
      return untracked;
    }
    this.untrackHandle(handle);
    this.cancelStreamStatus(handle.childStreamId);
    return true;
  }

  /**
   * Mark a stream CANCELLED from a user stop. The status machine publishes the
   * canonical session fact itself — the single status rail every consumer,
   * including the transcript recorder, subscribes to — so no caller routes it.
   */
  private cancelStreamStatus(streamId: StreamTabId): void {
    this.streamStatus.transition(streamId, STREAM_PHASE.CANCELLED, 'user-stop');
  }

  private notifyWaiters(executionId: string): void {
    const listeners = this.listeners.get(executionId);
    if (!listeners) return;

    const handle = this.handles.get(executionId);
    // Iterate a snapshot so a listener disposing itself mid-fire is safe.
    for (const cb of [...listeners]) cb(handle);

    // Backstop against listener leaks: if the execution is no longer tracked,
    // any still-registered persistent listener is firing into the void.
    if (!this.handles.has(executionId)) {
      this.listeners.delete(executionId);
    }
  }

  private notifyRegistrationListeners(
    executionId: string,
    handle: AgentExecutionHandle | undefined,
  ): void {
    for (const listener of [...this.registrationListeners]) {
      listener(executionId, handle);
    }
  }

  private releaseChildActivation(
    executionId: string,
    expected?: ChildExecutionActivation,
  ): void {
    const activation = this.childActivations.get(executionId);
    if (!activation || (expected && activation !== expected)) return;
    this.childActivations.delete(executionId);
    this.notifyChildActivationListeners(activation, false);
  }

  private notifyChildActivationListeners(
    activation: ChildExecutionActivation,
    active: boolean,
  ): void {
    for (const listener of [...this.childActivationListeners]) {
      listener(activation, active);
    }
  }
}
