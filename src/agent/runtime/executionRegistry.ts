/**
 * Handle-based execution registry.
 *
 * Manages agent execution handles and provides registration, lookup, change
 * notification, and subagent lineage tracking in a single module.
 */

import type { ResultEvent } from '@agent/trace';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionApprovals } from '@agent/runtime/streamApprovalQueue';
import type { StreamStatusMachine } from '@agent/runtime/StreamStatusService';
import {
  STREAM_PHASE,
  STREAM_SUBSTATE,
  type ActiveChildInfo,
  type ExecutionId,
  type SessionEventDraft,
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
  type AgentExecutionHandle,
  type ExecutionStatusInfo,
  type LiveToolUseFlowContext,
} from './ExecutionHandle';
import { ExecutionInteractionOwnership } from './executionInteractionOwnership';
import { ExecutionLanes } from './executionLanes';
import { WaitingTermination } from './waitingTermination';

/**
 * Child policy shared by `kill()` and `stopAgentStream()`. The caller owns the
 * decision because only it knows which gesture it is serving: the configured
 * stop surfaces resolve it through `detachSubagentsOnStop()`, the CLI's
 * focus-scoped bare-Escape stop always detaches, and process shutdown always
 * cascades. Omitting the field means cascade — the conservative reading, since
 * a child left running has no owner to report to.
 */
interface ExecutionStopOptions {
  readonly detachActiveChildren?: boolean;
}

/**
 * A native child loop's lineage for the loop's whole life: from the
 * synchronous start of the loop, across every turn handle it tracks and
 * untracks, until its final result has been delivered to the parent. The
 * parent counts it as an active child throughout, so the parent's continuation
 * stays recoverable until the last delivery has landed. Child-stream loops use
 * their persistent execution handle for lineage instead.
 */
export interface ChildExecutionActivation {
  readonly executionId: ExecutionId;
  readonly parentStreamId: StreamTabId;
  readonly childStreamId: StreamTabId;
  readonly interrupt: () => void;
  readonly detach: () => void;
  readonly isDetached: () => boolean;
}

/**
 * Where a follow-up for a stream goes: a live flow context, the stream's
 * retained queue (a WAITING or resuming cursor, or a parent whose children
 * are still active), or nowhere in this process.
 */
export type ToolUseFollowUpTarget =
  | {
      readonly kind: 'active';
      readonly context: LiveToolUseFlowContext;
    }
  | { readonly kind: 'queue' }
  | {
      readonly kind: 'no_session';
      readonly streamStatus: StreamPhase | undefined;
    };

type ManualCompactionRequestResult =
  | {
      readonly kind: 'requested';
      readonly streamId: StreamTabId;
      readonly session: SessionHandle;
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
 * A caller bringing its own status machine must route that machine's facts
 * through `handleStatus`: the registry's waiters and child rosters follow the
 * canonical status rail, and a machine publishing elsewhere would leave them
 * listening where nothing is ever published.
 */
interface ExecutionRegistryInit {
  readonly streamStatus: StreamStatusMachine;
  /** The session's publisher (`SessionHandle.publish`) for the registry's
   *  own durable fact, the parent edge (`setParentStream`). */
  readonly publish: (events: readonly SessionEventDraft[]) => void;
  readonly approvals: SessionApprovals;
  readonly publishResult: (event: ResultEvent, streamId: StreamTabId) => void;
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
  /** Set by {@link closeAdmissions}: the session is closing. */
  private closing = false;
  private readonly streamStatus: StreamStatusMachine;
  private readonly publish: (events: readonly SessionEventDraft[]) => void;
  private readonly childActivityListeners = new Set<
    (parentStreamId: StreamTabId, items: readonly ActiveChildInfo[]) => void
  >();
  private readonly approvals: SessionApprovals;
  /**
   * Publishes a synthesized terminal `result` event to the owning session's
   * `onResult` channel — the same forwarding `SessionHandle.attachRunTrace`
   * does for a live run's own trace, injected here because
   * `terminateWaitingHandle` produces its `result` event *after* the
   * suspended run's own trace has already been disposed (see there).
   */
  private readonly publishResult: (
    event: ResultEvent,
    streamId: StreamTabId,
  ) => void;
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
  private readonly lanes = new ExecutionLanes();
  private readonly waitingTermination: WaitingTermination;

  constructor(options: ExecutionRegistryInit) {
    this.publish = options.publish;
    this.streamStatus = options.streamStatus;
    this.approvals = options.approvals;
    this.publishResult = options.publishResult;
    this.releaseRootExecutionLease = options.releaseRootExecutionLease;
    this.waitingTermination = new WaitingTermination({
      publishResult: this.publishResult,
      releaseRootExecutionLease: this.releaseRootExecutionLease,
      lanes: this.lanes,
      getHandle: (executionId) => this.handles.get(executionId),
      untrackIfCurrent: (handle) => this.untrackIfCurrent(handle),
      untrackHandle: (handle) => this.untrackHandle(handle),
      cancelStreamStatus: (streamId) => this.cancelStreamStatus(streamId),
    });
  }

  /**
   * The live child roster of a parent stream, as this registry holds it:
   * live-only presentation state (never a plane row, contract C3), told to
   * the renderers that still draw a roster until the fold's `childIds` and
   * `rollup` replace it (PRD 5.1). Called on every roster change: a child
   * tracked, untracked, detached, or moved by a canonical `status` fact.
   */
  onChildActivity(
    listener: (
      parentStreamId: StreamTabId,
      items: readonly ActiveChildInfo[],
    ) => void,
  ): () => void {
    this.childActivityListeners.add(listener);
    return () => {
      this.childActivityListeners.delete(listener);
    };
  }

  /**
   * One canonical `status` fact, from the session's `publishStatus` in
   * publish order and before any renderer wakes: notify waiters and refresh
   * the child roster when a stream's status changes (e.g. RUNNING to WAITING).
   */
  handleStatus(streamId: StreamTabId): void {
    if (this.disposed) return;
    const handle = this.getAgentHandleByStream(streamId);
    if (!handle) return;
    this.notifyWaiters(handle.executionId);
    if (handle.isChildExecution) {
      this.emitChildActivity(handle.parentStreamId);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.childActivityListeners.clear();
    const disposal = new Error(
      'Cannot register execution work after session disposal.',
    );
    this.lanes.disposeAll(disposal);
    const executionIds = [...this.handles.keys()];
    this.handles.clear();
    for (const executionId of executionIds) {
      this.notifyRegistrationListeners(executionId, undefined);
      this.notifyWaiters(executionId);
    }
    for (const activation of this.childActivations.values()) {
      this.interactionOwnership.observeChildActivation(activation, false);
    }
    this.childActivations.clear();
    this.listeners.clear();
    this.registrationListeners.clear();
    this.interactionOwnership.dispose();
  }

  /**
   * Whether `streamId` is running, resuming, or parked with a live flow in this
   * process: the states in which a resume must be refused outright rather than
   * queued on the execution lane, since it would otherwise start a fresh
   * generation of a run that just finished.
   */
  isActiveOrResuming(streamId: StreamTabId): boolean {
    return (
      isActivePhase(this.streamStatus.get(streamId)) ||
      this.streamStatus.getSubstate(streamId) === STREAM_SUBSTATE.RESUMING ||
      this.getToolUseFlowContext(streamId) !== undefined
    );
  }

  /**
   * Run one lifecycle step of `executionId` after every earlier step has
   * returned and the generation the last launch started has disposed.
   */
  runExecutionStep<T>(executionId: string, step: () => Promise<T>): Promise<T> {
    this.assertActive();
    return this.lanes.enqueue(executionId, step);
  }

  /**
   * Launch a generation of `executionId` as a lifecycle step: `start` begins
   * once the previous generation has disposed, and its promise becomes the
   * generation later steps wait on. The step itself returns as soon as the run
   * has begun, so a parent launching a child is never held by the child's
   * lifetime and a step never waits on a run for which it holds the lane.
   */
  launchExecution<T>(executionId: string, start: () => Promise<T>): Promise<T> {
    this.assertActive();
    return this.lanes.launch(executionId, start);
  }

  /** Register an execution handle. */
  track(handle: AgentExecutionHandle): void {
    this.assertActive();
    const previous = this.handles.get(handle.executionId);
    const activation = this.childActivations.get(handle.executionId);
    if (activation?.isDetached()) handle.detach();
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
    this.notifyWaiters(handle.executionId);
  }

  /**
   * Register an agent execution and, when requested, publish its initial
   * stream status through the registry-owned status store.
   */
  trackAgentExecution(
    handle: AgentExecutionHandle,
    options: { readonly status: StreamPhase },
  ): void {
    this.assertActive();
    const previousStatus = this.streamStatus.get(handle.childStreamId);
    const cause =
      options.status === STREAM_PHASE.RUNNING &&
      isTerminalOutcomePhase(previousStatus)
        ? 'resume'
        : 'lifecycle';
    this.streamStatus.transition(handle.childStreamId, options.status, cause);
    this.track(handle);
  }

  /**
   * Refuse every execution registered from here on: the session is closing
   * (`Sessions.close`). The executions already tracked keep their handles,
   * waiters, and status until they settle, which is what the close waits
   * for; only new admissions are turned away.
   */
  closeAdmissions(): void {
    this.closing = true;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('Cannot register execution work after session disposal.');
    }
    if (this.closing) {
      throw new Error(
        'Cannot register execution work while the session is closing.',
      );
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
    const phaseState = this.streamStatus.getStreamState(handle.childStreamId);
    const status = phaseState?.phase ?? STREAM_PHASE.RUNNING;
    const runStartedAt = phaseState?.runStartedAt;

    if (!isActivePhase(status) || runStartedAt === undefined) {
      return { status, elapsed: null };
    }

    return {
      status,
      elapsed: formatDuration(Date.now() - runStartedAt),
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
    if (!streamId) return { kind: 'no_active_tool_use' };
    const context = this.getToolUseFlowContext(streamId);
    if (!context) return { kind: 'no_active_tool_use', streamId };

    if (!context.modelHandler.supportsManualCompaction) {
      return { kind: 'unsupported', streamId };
    }

    context.requestImmediateCompaction();
    return {
      kind: 'requested',
      streamId,
      session: context.ownerSession,
    };
  }

  /**
   * Decide how a tool-use follow-up should be admitted from one registry-owned
   * snapshot of stream status, active flow context, and child executions.
   */
  getToolUseFollowUpTarget(streamId: StreamTabId): ToolUseFollowUpTarget {
    const status = this.streamStatus.get(streamId);

    if (status !== undefined && !isInFlightPhase(status)) {
      // Only a native child's explicit delivery reservation can retain a
      // terminal parent's continuation. A child-stream handle is lifecycle
      // ownership, not authority to revive a parent that already finished.
      for (const activation of this.activeChildActivations(streamId)) {
        return { kind: 'queue' };
      }
      return { kind: 'no_session', streamStatus: status };
    }

    const hasActiveChildren = this.hasActiveChildren(streamId);
    const context = this.getToolUseFlowContext(streamId);
    if (context) return { kind: 'active', context };

    if (
      this.streamStatus.getSubstate(streamId) === STREAM_SUBSTATE.RESUMING ||
      status === STREAM_PHASE.WAITING ||
      hasActiveChildren
    ) {
      return { kind: 'queue' };
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
    const result = this.terminate(
      handle,
      visited,
      options.detachActiveChildren !== true,
    );
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
   * stream status. Agent executions are left in RUNNING: whether one is
   * resumable afterwards is decided from its durable facts (a flow record on
   * disk, and no live owner), never from a phase some later pass rewrites.
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
   * Wait for any of the given executions to change — see {@link addListener}
   * for the full wake set. Pass an AbortSignal for timeout cleanup.
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

  private *activeChildActivations(
    parentStreamId: StreamTabId,
  ): Generator<ChildExecutionActivation> {
    for (const activation of this.childActivations.values()) {
      if (
        activation.parentStreamId === parentStreamId &&
        !activation.isDetached()
      ) {
        yield activation;
      }
    }
  }

  /** Interrupt all active subagents of a parent stream, including descendants. */
  private interruptActiveChildren(
    parentStreamId: StreamTabId,
    visited: Set<string>,
    cascadeChildren: boolean,
  ): void {
    // A loop between turns has no handle to interrupt; a loop inside a turn
    // also gets its turn handle terminated below. The activation is keyed
    // apart from the handle so each is interrupted once per stop.
    for (const activation of this.activeChildActivations(parentStreamId)) {
      const key = `activation:${activation.executionId}`;
      if (visited.has(key)) continue;
      visited.add(key);
      activation.interrupt();
    }
    for (const handle of this.handles.values()) {
      if (handle.isOwnedBy(parentStreamId)) {
        this.terminate(handle, visited, cascadeChildren);
      }
    }
  }

  /**
   * Detach all active subagents from a parent, promoting them to top-level.
   * Subagents continue running independently and deliver results via the
   * follow-up queue. Called when stopping an orchestrator without killing
   * children.
   *
   * Returns the child streams whose parent edge this call already cleared and
   * emitted — activations included, which is why a caller must not re-derive
   * the set from `getActiveChildren` (handles only) and emit `setParentStream`
   * for the difference: a native child between turns would be emitted twice.
   */
  detachActiveChildren(parentStreamId: StreamTabId): readonly StreamTabId[] {
    // A Set, not an array: a child detached mid-turn has both a per-turn
    // handle and a ChildExecutionActivation under one executionId, so both
    // loops below reach the same childStreamId and it must still be emitted
    // (and reported) exactly once.
    const detachedChildStreamIds = new Set<StreamTabId>();
    for (const activation of this.activeChildActivations(parentStreamId)) {
      activation.detach();
      this.approvals.detachStreamFromParent(activation.childStreamId);
      detachedChildStreamIds.add(activation.childStreamId);
    }
    for (const handle of this.handles.values()) {
      if (!handle.isOwnedBy(parentStreamId)) continue;
      this.approvals.detachStreamFromParent(handle.childStreamId);
      handle.detach();
      detachedChildStreamIds.add(handle.childStreamId);
    }
    this.emitChildActivity(parentStreamId);
    for (const childStreamId of detachedChildStreamIds) {
      this.emitParentStreamUpdate({
        childStreamId,
        parentStreamId: null,
      });
    }
    return [...detachedChildStreamIds];
  }

  /**
   * Stop a visible agent stream and apply the caller's declared child policy.
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
      this.interruptActiveChildren(streamId, visited, true);
    }

    const stopped = rootHandle
      ? this.terminate(
          rootHandle,
          visited,
          options.detachActiveChildren !== true,
        )
      : false;
    // `terminate()` already publishes CANCELLED for a stream it owned; an
    // ownerless (or already-untracked) stream still needs the write. The
    // stream-status machine rejects the transition out of a terminal phase,
    // so a finished stream keeps its outcome.
    if (stopped) return;
    this.cancelStreamStatus(streamId);
  }

  /**
   * Register a change waiter for `executionId` and return its disposer.
   *
   * The full wake set, which is what an `executions wait` observes:
   *
   * - a status transition on this execution's child stream;
   * - {@link track}, including a *replacement* handle for the same id (a
   *   resumed generation taking over from its predecessor) — a `track` that
   *   skipped this would strand a waiter across a resume;
   * - {@link untrack}, including for an id that holds no handle;
   * - {@link kill}, unconditionally, even when no live interrupt target was
   *   reached;
   * - {@link dispose}, for every execution still tracked at session teardown.
   *
   * Private: the only caller is {@link waitForAnyChange}, which detaches
   * inside the callback, so nothing observes a second wake through the same
   * callback.
   *
   * The callback receives the current handle, or `undefined` once the
   * execution has been untracked (terminal event) or the session disposed.
   */
  private addListener(
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
   * Retain a native child loop's lineage until the returned disposer runs,
   * which the loop does only after its final delivery to the parent.
   */
  reserveChildActivation(activation: ChildExecutionActivation): () => void {
    this.assertActive();
    if (this.childActivations.has(activation.executionId)) {
      return () => {};
    }
    this.childActivations.set(activation.executionId, activation);
    this.interactionOwnership.observeChildActivation(activation, true);
    return () =>
      this.releaseChildActivation(activation.executionId, activation);
  }

  private emitChildActivity(parentStreamId: StreamTabId): void {
    const items = this.getActiveChildren(parentStreamId);
    for (const listener of [...this.childActivityListeners]) {
      listener(parentStreamId, items);
    }
  }

  private emitParentStreamUpdate(payload: {
    readonly childStreamId: StreamTabId;
    readonly parentStreamId: StreamTabId | null;
  }): void {
    this.publish([
      {
        type: 'setParentStream',
        aggregateId: payload.childStreamId,
        parentStreamId: payload.parentStreamId,
      },
    ]);
  }

  /** Get active subagent children for a parent stream. */
  getActiveChildren(parentStreamId: StreamTabId): ActiveChildInfo[] {
    const result: ActiveChildInfo[] = [];
    for (const handle of this.handles.values()) {
      if (!handle.isOwnedBy(parentStreamId)) continue;
      const { status } = this.getStatus(handle);
      result.push({
        executionId: handle.executionId,
        identity: handle.identity,
        agentName: handle.agentName,
        status,
        startedAt: handle.startedAt,
        childStreamId: handle.childStreamId,
        ...(handle.workflowPhase
          ? { workflowPhase: handle.workflowPhase }
          : {}),
      });
    }
    return result;
  }

  hasActiveChildren(parentStreamId: StreamTabId): boolean {
    for (const activation of this.activeChildActivations(parentStreamId)) {
      return true;
    }
    for (const handle of this.handles.values()) {
      if (handle.isOwnedBy(parentStreamId)) return true;
    }
    return false;
  }

  private terminate(
    handle: AgentExecutionHandle,
    visited: Set<string>,
    cascadeChildren: boolean,
  ): boolean {
    if (visited.has(handle.executionId)) return false;
    visited.add(handle.executionId);
    if (cascadeChildren) {
      this.interruptActiveChildren(handle.childStreamId, visited, true);
    }
    // A child execution is its loop, not only the turn this handle runs:
    // stopping it ends the loop too, so the interrupted turn is not delivered
    // to the parent as a completed one.
    const activation = this.childActivations.get(handle.executionId);
    if (activation && !activation.isDetached()) {
      const key = `activation:${activation.executionId}`;
      if (!visited.has(key)) {
        visited.add(key);
        activation.interrupt();
      }
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
    return this.waitingTermination.terminateWaitingHandle(handle);
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
    expected: ChildExecutionActivation,
  ): void {
    if (this.childActivations.get(executionId) !== expected) return;
    this.childActivations.delete(executionId);
    this.interactionOwnership.observeChildActivation(expected, false);
  }
}
