/**
 * Handle-based execution registry.
 *
 * Manages ExecutionHandle instances and provides registration, lookup, change
 * notification, and subagent lineage tracking in a single module.
 */

import { synchronizeAgentResultOutcome } from '@agent/storage';
import { createChannelTrace, type ResultEvent } from '@agent/trace';
import {
  completeOwnedExecutionLease,
  ExecutionLeaseLostError,
  markOwnedExecutionLeaseUndurable,
} from '@agent/storage/executionLease';
import { persistTerminalExecution } from '@agent/runtime/AgentRunLifecycle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionApprovals } from '@agent/runtime/streamApprovalQueue';
import {
  StreamStatusMachine,
  type StreamStatusEmitOptions,
} from '@agent/runtime/StreamStatusService';
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
import { formatDuration } from '@utils/core';
import {
  type ExecutionHandle,
  type ExecutionStatusInfo,
  type LiveToolUseFlowContext,
  AgentExecutionHandle,
  isChildExecution,
} from './ExecutionHandle';
import { SessionEventHub } from './SessionEventHub';

const logger = createChannelTrace('executionRegistry');

/** Child policy shared by `kill()` and `stopAgentStream()`. */
export interface ExecutionStopOptions {
  readonly detachActiveChildren?: boolean;
}

export interface TrackAgentExecutionOptions {
  readonly status?: StreamPhase;
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
 * Process-wide owner for active executions and their change listeners.
 *
 * This is still a singleton while AgentRun ownership is being introduced, but
 * the mutable maps and status subscription now live behind one explicit owner
 * instead of free module state.
 */
export class ExecutionRegistry {
  private readonly handles = new Map<string, ExecutionHandle>();
  private disposed = false;
  private readonly changeCallbacks = new Map<string, Array<() => void>>();
  private readonly disposeStatusListener: () => void;
  private readonly streamStatus: StreamStatusMachine;
  private events: SessionEventHub | undefined;
  private approvals: SessionApprovals | undefined;
  /**
   * Publishes a synthesized terminal `result` event to the owning session's
   * `onResult` channel — the same forwarding `SessionHandle.attachRunTrace`
   * does for a live run's own trace, injected here because
   * `terminateWaitingHandle` produces its `result` event *after* the
   * suspended run's own trace has already been disposed (see there).
   */
  private publishResult:
    ((event: ResultEvent, streamId: StreamTabId) => void) | undefined;
  private releaseRootExecutionLease = (executionId: ExecutionId) =>
    completeOwnedExecutionLease(executionId);
  // Persistent listeners stay attached across notifications (unlike one-shot
  // waiters in `changeCallbacks`). Used by the executions subscribe action.
  private readonly persistentListeners = new Map<
    string,
    Set<(handle: ExecutionHandle | undefined) => void>
  >();
  private readonly registrationListeners = new Set<
    (executionId: string, handle: ExecutionHandle | undefined) => void
  >();
  private readonly childActivations = new Map<
    string,
    ChildExecutionActivation
  >();
  private readonly childActivationListeners = new Set<
    (activation: ChildExecutionActivation, active: boolean) => void
  >();

  constructor({
    events = new SessionEventHub(),
    streamStatus = new StreamStatusMachine(events),
    publishResult,
  }: {
    readonly streamStatus?: StreamStatusMachine;
    readonly events?: SessionEventHub;
    readonly publishResult?: (
      event: ResultEvent,
      streamId: StreamTabId,
    ) => void;
  } = {}) {
    this.streamStatus = streamStatus;
    this.attachSessionEvents(events, publishResult);
    // Notify waiters and refresh UI badges when stream status changes
    // (e.g. RUNNING → WAITING). Without this, waitForChange only resolves
    // on progress/kill/untrack, and the background-tasks panel shows stale badges.
    this.disposeStatusListener = this.streamStatus.onDidChange(
      ({ streamId }) => {
        for (const [executionId, handle] of this.handles) {
          if (
            handle instanceof AgentExecutionHandle &&
            handle.childStreamId === streamId
          ) {
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

  attachSessionEvents(
    events: SessionEventHub,
    publishResult?: (event: ResultEvent, streamId: StreamTabId) => void,
  ): void {
    this.events = events;
    if (publishResult) this.publishResult = publishResult;
  }

  /** Bind the session-owned approval state used when a child is detached. */
  attachSessionApprovals(approvals: SessionApprovals): void {
    this.approvals = approvals;
  }

  /** Bind the owning session's durable-artifact boundary to root release. */
  attachRootExecutionLeaseRelease(
    release: (executionId: ExecutionId) => Promise<void>,
  ): void {
    this.releaseRootExecutionLease = release;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeStatusListener();
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
    this.changeCallbacks.clear();
    this.persistentListeners.clear();
    this.registrationListeners.clear();
    this.childActivationListeners.clear();
  }

  /** Register an execution handle. */
  track(handle: ExecutionHandle): void {
    this.assertActive();
    const previous = this.handles.get(handle.executionId);
    if (
      previous instanceof AgentExecutionHandle &&
      handle instanceof AgentExecutionHandle &&
      previous.waitingTerminationStarted
    ) {
      // A resumed lifecycle can replace its suspended predecessor while the
      // predecessor's asynchronous waiting cleanup is still in progress. The
      // stop already claimed that execution, so carry it across the ownership
      // handoff instead of allowing the successor to revive the run.
      handle.interrupt();
    }
    this.handles.set(handle.executionId, handle);
    if (handle instanceof AgentExecutionHandle && handle.isChildExecution) {
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
    options: TrackAgentExecutionOptions = {},
  ): void {
    this.assertActive();
    if (options.status) {
      const previousStatus = this.streamStatus.get(handle.childStreamId);
      const cause =
        options.status === STREAM_PHASE.RUNNING &&
        isTerminalOutcomePhase(previousStatus)
          ? 'resume'
          : 'lifecycle';
      this.streamStatus.transition(
        handle.childStreamId,
        options.status,
        cause,
        this.streamStatusEmitOptions(handle),
      );
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
    return this.streamStatus.transition(
      handle.childStreamId,
      status,
      cause,
      this.streamStatusEmitOptions(handle),
    );
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
  untrackIfCurrent(handle: ExecutionHandle): boolean {
    if (this.handles.get(handle.executionId) !== handle) return false;
    this.untrackHandle(handle);
    return true;
  }

  private untrackHandle(handle: ExecutionHandle): void {
    this.handles.delete(handle.executionId);
    this.notifyRegistrationListeners(handle.executionId, undefined);
    this.notifyWaiters(handle.executionId);
    if (handle instanceof AgentExecutionHandle && handle.isChildExecution) {
      this.emitChildActivity(handle.parentStreamId);
    }
  }

  getHandle(executionId: string): ExecutionHandle | undefined {
    return this.handles.get(executionId);
  }

  getStatus(
    handle: ExecutionHandle,
  ): ExecutionStatusInfo & { status: StreamPhase } {
    const status =
      handle instanceof AgentExecutionHandle
        ? (this.streamStatus.get(handle.childStreamId) ?? STREAM_PHASE.RUNNING)
        : STREAM_PHASE.RUNNING;

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
      if (
        handle instanceof AgentExecutionHandle &&
        handle.childStreamId === streamId
      ) {
        return handle;
      }
    }
    return undefined;
  }

  getAgentHandles(): AgentExecutionHandle[] {
    return [...this.handles.values()].filter(
      (handle): handle is AgentExecutionHandle =>
        handle instanceof AgentExecutionHandle,
    );
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
    if (
      options.detachActiveChildren === true &&
      handle instanceof AgentExecutionHandle
    ) {
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
      if (handle instanceof AgentExecutionHandle) {
        handle.interruptBackgroundProcess();
      }
    }
  }

  /**
   * Wait for any change on an execution: status transition, kill, or
   * completion (untrack). Pass an AbortSignal for timeout cleanup.
   */
  waitForChange(executionId: string, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const cb = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        this.removeChangeCallback(executionId, cb);
        resolve();
      };
      this.addChangeCallback(executionId, cb);
      signal?.addEventListener('abort', onAbort, { once: true });
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
      const callbacks = new Map<string, () => void>();

      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
        for (const [id, cb] of callbacks) {
          this.removeChangeCallback(id, cb);
        }
      };

      const onAbort = (): void => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve('');
      };

      for (const id of executionIds) {
        const cb = (): void => {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve(id);
        };
        callbacks.set(id, cb);
        this.addChangeCallback(id, cb);
      }

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Interrupt all active subagents of a parent stream, including descendants. */
  interruptActiveChildren(
    parentStreamId: StreamTabId,
    visited: Set<string> = new Set(),
    options: TerminateOptions = { cascadeChildren: true },
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
      if (handle instanceof AgentExecutionHandle) {
        this.approvals?.detachStreamFromParent(handle.childStreamId);
        handle.detach();
        this.emitParentStreamUpdate({
          childStreamId: handle.childStreamId,
          parentStreamId: null,
        });
      }
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

  /** Get active subagent children for a parent stream. */
  getActiveChildren(parentStreamId: StreamTabId): ActiveChildInfo[] {
    return this.collectChildSummary(parentStreamId);
  }

  /**
   * Add a persistent listener invoked on every change to `executionId` (status
   * transition, progress update, kill, untrack). Returns a disposer.
   *
   * The callback receives the current `ExecutionHandle`, or `undefined` once the
   * execution has been untracked (terminal event).
   */
  addListener(
    executionId: string,
    cb: (handle: ExecutionHandle | undefined) => void,
  ): () => void {
    let set = this.persistentListeners.get(executionId);
    if (!set) {
      set = new Set();
      this.persistentListeners.set(executionId, set);
    }
    set.add(cb);
    return () => {
      const s = this.persistentListeners.get(executionId);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.persistentListeners.delete(executionId);
    };
  }

  /** Observe handle registrations, replacements, and removals across all ids. */
  addRegistrationListener(
    cb: (executionId: string, handle: ExecutionHandle | undefined) => void,
  ): () => void {
    this.registrationListeners.add(cb);
    return () => {
      this.registrationListeners.delete(cb);
    };
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
    this.childActivationListeners.add(cb);
    return () => {
      this.childActivationListeners.delete(cb);
    };
  }

  private emitChildActivity(parentStreamId: StreamTabId): void {
    this.requireSessionEvents().emit({
      scope: 'run',
      streamId: parentStreamId,
      event: {
        type: 'child.activity',
        parentStreamId,
        items: this.collectChildSummary(parentStreamId),
      },
    });
  }

  private emitParentStreamUpdate(payload: {
    readonly childStreamId: StreamTabId;
    readonly parentStreamId: StreamTabId | null;
  }): void {
    this.requireSessionEvents().emit({
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

  private requireSessionEvents(): SessionEventHub {
    if (!this.events) {
      throw new Error(
        'ExecutionRegistry child updates require SessionEventHub',
      );
    }
    return this.events;
  }

  private collectChildSummary(parentStreamId: StreamTabId): ActiveChildInfo[] {
    const result: ActiveChildInfo[] = [];
    for (const handle of this.handles.values()) {
      if (
        !(handle instanceof AgentExecutionHandle) ||
        !isChildExecution(handle, parentStreamId)
      ) {
        continue;
      }
      const { status, elapsed } = this.getStatus(handle);
      result.push({
        kind: 'subagent',
        executionId: handle.executionId,
        agentName: handle.agentName,
        status,
        startedAt: handle.startedAt,
        elapsed: elapsed ?? null,
        childStreamId: handle.childStreamId,
        ...(handle.toolName ? { toolName: handle.toolName } : {}),
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
    handle: ExecutionHandle,
    visited: Set<string> = new Set(),
    options: TerminateOptions = {},
  ): boolean {
    if (visited.has(handle.executionId)) return false;
    visited.add(handle.executionId);
    if (handle instanceof AgentExecutionHandle) {
      if (options.cascadeChildren === true) {
        this.interruptActiveChildren(handle.childStreamId, visited, options);
      }
      if (handle.interrupt()) {
        this.cancelStreamStatus(handle.childStreamId, handle);
        return true;
      }
      // No live interrupt context: a native subagent suspended at WAITING has
      // already had its tool-use session disposed and interrupt handler detached
      // (runToolUseFlow's finally), while the handle stays tracked for resume
      // (runFlowWithLifecycle). Run its registered waiting-cleanup instead of
      // silently no-oping the kill.
      return this.terminateWaitingHandle(handle);
    }

    return false;
  }

  /**
   * Tear down an `AgentExecutionHandle` suspended at WAITING (or transitioning
   * out of it via a resume that hasn't yet installed its own live context)
   * with no live interrupt context. Returns false (no-op) when the handle
   * never registered a waiting-cleanup — i.e. it isn't actually suspended,
   * just momentarily between its own interrupt-handler detach and untrack during
   * normal teardown — or when `streamStatus` shows neither state (see below).
   *
   * A registered waiting-cleanup alone does not prove the run is genuinely
   * suspended: `runFlowWithLifecycle`'s own WAITING branch is the only
   * registrant today (native subagent turns are loop-driven — see
   * `childRunLoop.ts` — with delivery choreography owned entirely by the
   * loop's single site, so there is no more per-strategy speculative
   * registration on every delivered turn). `runFlowWithLifecycle` clears
   * this registration (`handle.clearWaitingCleanup()`) on both of its
   * non-WAITING terminal arms, so in practice a stale cleanup is gone well
   * before this method could ever see it — but this method does not rely on
   * every non-waiting exit remembering to call that: `streamStatus` only
   * reaches `WAITING` on the genuine suspend path (`ToolUseWaitNode` only
   * transitions to WAITING when it is actually suspending — unconditionally
   * for a subagent cycle, or after the queue is confirmed empty for a root
   * cycle), so checking it here is an independent, authoritative
   * confirmation that this handle is really parked, not mid-flight — belt
   * and suspenders against a future non-waiting exit that forgets the clear
   * (see #7324 review discussion).
   *
   * `resumeQueuedToolUseFromResumeData` flips `streamStatus` to RUNNING with a
   * RESUMING substate *before* the resumed run installs its own interrupt
   * context, so a stop landing in that window would otherwise find this same
   * still-WAITING-suspended handle but a non-WAITING phase, and get wrongly
   * no-opped by the check above. `getToolUseFollowUpTarget` already treats
   * RESUMING the same as WAITING for the analogous follow-up-admission
   * decision — mirrored here so a stop during that window still tears the
   * stalled resume down instead of silently ignoring it.
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
    const status = this.streamStatus.get(handle.childStreamId);
    const resuming =
      this.streamStatus.getSubstate(handle.childStreamId) ===
      STREAM_SUBSTATE.RESUMING;
    if (status !== STREAM_PHASE.WAITING && !resuming) {
      return false;
    }
    if (!handle.runWaitingCleanup()) return false;
    const cancelledResult: ResultEvent = {
      type: 'result',
      outcome: RUN_OUTCOME.CANCELLED,
      executionId: handle.executionId,
      streamId: handle.childStreamId,
      agentName: handle.agentName,
      category: handle.category,
      isSubagent: handle.isChildExecution,
    };
    void this.finishWaitingTermination(handle, cancelledResult).catch(
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
            logger.warn('Waiting-execution termination failed unexpectedly', {
              data: { executionId: handle.executionId, recoveryFailures },
            });
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
            this.cancelStreamStatus(handle.childStreamId, handle);
          }
        } catch (recoveryError) {
          recoveryFailures.push(recoveryError);
        }
        logger.warn('Waiting-execution termination failed unexpectedly', {
          data: { executionId: handle.executionId, recoveryFailures },
        });
      },
    );
    return true;
  }

  private async finishWaitingTermination(
    handle: AgentExecutionHandle,
    cancelledResult: ResultEvent,
  ): Promise<void> {
    return await handle.runWithExecutionLease(async () => {
      try {
        await handle.waitForWaitingCleanup();
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

      // No later result write is guaranteed here, including during RESUMING:
      // the resume can fail before installing its own handle, while this method
      // has already untracked the suspended one. Align the interim envelope only
      // after durable terminal metadata exists. A turn that does continue will
      // replace it with its own result.
      try {
        const result = await persistTerminalExecution({
          executionId: handle.executionId,
          outcome: RUN_OUTCOME.CANCELLED,
          flowRecord: 'delete',
          logger,
          failedMessage: 'Failed to finalize stopped waiting execution',
          rejectedMessage: 'Waiting-execution finalizer rejected unexpectedly',
        });
        if (result.terminalStatusPersisted) {
          await synchronizeAgentResultOutcome(
            handle.executionId,
            RUN_OUTCOME.CANCELLED,
          );
        }
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
        this.cancelStreamStatus(handle.childStreamId, handle);
      }
      return untracked;
    }
    this.untrackHandle(handle);
    this.cancelStreamStatus(handle.childStreamId, handle);
    return true;
  }

  private streamStatusEmitOptions(
    handle?: AgentExecutionHandle,
  ): StreamStatusEmitOptions {
    return handle?.trace ? { trace: handle.trace } : {};
  }

  /**
   * Mark a stream CANCELLED from a user stop. Passes the handle's trace when
   * one is available; the session-fact rail is published by the status machine
   * itself, so no caller has to route it (see {@link streamStatusEmitOptions}).
   */
  private cancelStreamStatus(
    streamId: StreamTabId,
    handle?: AgentExecutionHandle,
  ): void {
    this.streamStatus.transition(
      streamId,
      STREAM_PHASE.CANCELLED,
      'user-stop',
      this.streamStatusEmitOptions(handle),
    );
  }

  private addChangeCallback(executionId: string, cb: () => void): void {
    let callbacks = this.changeCallbacks.get(executionId);
    if (!callbacks) {
      callbacks = [];
      this.changeCallbacks.set(executionId, callbacks);
    }
    callbacks.push(cb);
  }

  private removeChangeCallback(executionId: string, cb: () => void): void {
    const callbacks = this.changeCallbacks.get(executionId);
    if (!callbacks) return;
    const idx = callbacks.indexOf(cb);
    if (idx !== -1) callbacks.splice(idx, 1);
    if (callbacks.length === 0) this.changeCallbacks.delete(executionId);
  }

  private notifyWaiters(executionId: string): void {
    const listeners = this.persistentListeners.get(executionId);
    const callbacks = this.changeCallbacks.get(executionId);
    if (!listeners && !callbacks) return;

    // Persistent listeners fire first and stay attached so subscribers keep
    // receiving every transition until they dispose themselves.
    if (listeners) {
      const handle = this.handles.get(executionId);
      // Iterate a snapshot so a listener disposing itself mid-fire is safe.
      for (const cb of [...listeners]) cb(handle);
    }

    if (callbacks) {
      this.changeCallbacks.delete(executionId);
      for (const cb of callbacks) cb();
    }

    // Backstop against listener leaks: if the execution is no longer tracked,
    // any still-registered persistent listener is firing into the void.
    if (!this.handles.has(executionId)) {
      this.persistentListeners.delete(executionId);
    }
  }

  private notifyRegistrationListeners(
    executionId: string,
    handle: ExecutionHandle | undefined,
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
