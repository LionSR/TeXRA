/**
 * Handle-based execution registry.
 *
 * Manages ExecutionHandle instances and provides registration, lookup, change
 * notification, and subagent lineage tracking in a single module.
 */

import {
  synchronizeAgentResultOutcome,
  writeTerminalStatus,
} from '@agent/storage';
import type { ResultEvent } from '@agent/trace';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  StreamStatusMachine,
  type StreamStatusEmitOptions,
} from '@agent/runtime/StreamStatusService';
import {
  isInFlightStatus,
  isLiveElapsedStatus,
  projectRunOutcome,
} from '@common/constants/streamStatus';
import {
  RUN_OUTCOME,
  STREAM_PHASE,
  STREAM_STATUS,
  STREAM_SUBSTATE,
  type ActiveChildInfo,
  type StreamPhase,
  type StreamTabId,
} from '@shared/schemas';
import { formatDuration } from '@utils/core';
import {
  type ExecutionHandle,
  type ExecutionStatusInfo,
  type LiveToolUseFlowContext,
  AgentExecutionHandle,
  ProcessExecutionHandle,
  isChildExecution,
} from './ExecutionHandle';
import { ProcessOutputPoller } from './ProcessOutputPoller';
import { SessionEventHub } from './SessionEventHub';

export type { ExecutionHandle } from './ExecutionHandle';
export {
  type ExecutionStatusInfo,
  type LiveToolUseFlowContext,
  type AgentRunHandle,
  ACTIVE_STATUSES,
  AgentExecutionHandle,
  ProcessExecutionHandle,
} from './ExecutionHandle';

export interface StopAgentStreamOptions {
  readonly detachActiveChildren?: boolean;
  readonly runtimeHost?: AgentRuntimeHost;
}

export type StopAgentChildPolicy = 'cascade' | 'detach';

export type StopAgentStreamResult =
  | {
      readonly kind: 'interrupted';
      readonly streamId: StreamTabId;
      readonly childPolicy: StopAgentChildPolicy;
    }
  | {
      readonly kind: 'marked_stopped';
      readonly streamId: StreamTabId;
      readonly childPolicy: StopAgentChildPolicy;
    }
  | {
      readonly kind: 'no_target';
      readonly streamId: StreamTabId;
      readonly childPolicy: StopAgentChildPolicy;
    }
  | {
      readonly kind: 'missing_runtime_host';
      readonly streamId: StreamTabId;
      readonly childPolicy: 'detach';
    };

export interface KillExecutionOptions {
  readonly detachActiveChildren?: boolean;
}

export interface TrackAgentExecutionOptions {
  readonly status?: StreamPhase;
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
  private readonly activeChildRunLoops = new Set<StreamTabId>();
  private readonly changeCallbacks = new Map<string, Array<() => void>>();
  private readonly disposeStatusListener: () => void;
  private readonly processOutput: ProcessOutputPoller;
  private readonly streamStatus: StreamStatusMachine;
  private events: SessionEventHub | undefined;
  /**
   * Publishes a synthesized terminal `result` event to the owning session's
   * `onResult` channel — the same forwarding `SessionHandle.attachRunTrace`
   * does for a live run's own trace, injected here because
   * `terminateWaitingHandle` produces its `result` event *after* the
   * suspended run's own trace has already been disposed (see there).
   */
  private publishResult:
    ((event: ResultEvent, streamId: StreamTabId) => void) | undefined;
  // Persistent listeners stay attached across notifications (unlike one-shot
  // waiters in `changeCallbacks`). Used by the executions subscribe action.
  private readonly persistentListeners = new Map<
    string,
    Set<(handle: ExecutionHandle | undefined) => void>
  >();
  private readonly registrationListeners = new Set<
    (executionId: string, handle: ExecutionHandle | undefined) => void
  >();

  constructor({
    processOutput = new ProcessOutputPoller(),
    streamStatus = new StreamStatusMachine(),
    events = new SessionEventHub(),
    publishResult,
  }: {
    readonly processOutput?: ProcessOutputPoller;
    readonly streamStatus?: StreamStatusMachine;
    readonly events?: SessionEventHub;
    readonly publishResult?: (
      event: ResultEvent,
      streamId: StreamTabId,
    ) => void;
  } = {}) {
    this.processOutput = processOutput;
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
              this.emitChildActivity(handle.parentStreamId, 'subagents');
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
    this.processOutput.setOutputEmitter((payload) => {
      events.emit({
        scope: 'run',
        streamId: payload.parentStreamId,
        event: {
          type: 'process.output',
          parentStreamId: payload.parentStreamId,
          executionId: payload.executionId,
          stdout: payload.stdout,
          stderr: payload.stderr,
        },
      });
    });
  }

  dispose(): void {
    this.disposeStatusListener();
    const executionIds = [...this.handles.keys()];
    this.handles.clear();
    this.activeChildRunLoops.clear();
    this.processOutput.dispose();
    for (const executionId of executionIds) {
      this.notifyRegistrationListeners(executionId, undefined);
      this.notifyWaiters(executionId);
    }
    this.changeCallbacks.clear();
    this.persistentListeners.clear();
    this.registrationListeners.clear();
  }

  /** Register a live child-run loop and return its lifecycle disposer. */
  registerChildRunLoop(streamId: StreamTabId): () => void {
    this.activeChildRunLoops.add(streamId);
    return () => {
      this.activeChildRunLoops.delete(streamId);
    };
  }

  /** True while this session owns a live child-run loop for `streamId`. */
  isChildRunLoopActive(streamId: StreamTabId): boolean {
    return this.activeChildRunLoops.has(streamId);
  }

  /** Register an execution handle. */
  track(handle: ExecutionHandle): void {
    this.handles.set(handle.executionId, handle);
    if (handle instanceof AgentExecutionHandle) {
      if (handle.isChildExecution) {
        this.emitChildActivity(handle.parentStreamId, 'subagents');
        this.emitParentStreamUpdate({
          childStreamId: handle.childStreamId,
          parentStreamId: handle.parentStreamId,
        });
      }
    } else if (handle instanceof ProcessExecutionHandle) {
      this.processOutput.register(handle);
      this.emitChildActivity(handle.parentStreamId, 'processes');
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
    options: TrackAgentExecutionOptions = {},
  ): void {
    if (options.status) {
      this.streamStatus.transition(
        handle.childStreamId,
        options.status,
        'lifecycle',
        this.streamStatusEmitOptions(handle),
      );
    }
    this.track(handle);
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
    const cause =
      status === STREAM_PHASE.WAITING
        ? 'wait'
        : status === STREAM_PHASE.RUNNING && previous === STREAM_PHASE.WAITING
          ? 'resume'
          : 'lifecycle';
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
      this.emitChildActivity(handle.parentStreamId, 'subagents');
      return;
    }

    if (handle instanceof ProcessExecutionHandle) {
      // The final read must complete before the badge update, because the
      // badge handler prunes output entries for processes no longer active.
      const finalize = (): void => {
        this.processOutput.unregister(handle.executionId);
        this.emitChildActivity(handle.parentStreamId, 'processes');
      };
      if (handle.outputPaths) {
        void this.processOutput.flush(handle).finally(finalize);
      } else {
        finalize();
      }
    }
  }

  getHandle(executionId: string): ExecutionHandle | undefined {
    return this.handles.get(executionId);
  }

  getStatus(handle: ExecutionHandle): ExecutionStatusInfo {
    const status =
      handle instanceof AgentExecutionHandle
        ? (this.streamStatus.get(handle.childStreamId) ?? STREAM_PHASE.RUNNING)
        : STREAM_PHASE.RUNNING;

    if (!isLiveElapsedStatus(status)) {
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

    if (status !== undefined && !isInFlightStatus(status)) {
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
  kill(executionId: string, options: KillExecutionOptions = {}): boolean {
    const handle = this.handles.get(executionId);
    if (!handle) return false;
    const visited = new Set<string>();
    if (
      options.detachActiveChildren === true &&
      handle instanceof AgentExecutionHandle
    ) {
      this.detachActiveChildren(
        handle.childStreamId,
        handle.runtimeHost,
        visited,
      );
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
   * A background `bash` run is also an `AgentExecutionHandle` (see
   * `createChildStream` in `tools/bash.ts`), not a `ProcessExecutionHandle` —
   * killing its underlying OS process requires `interruptBackgroundProcess()`,
   * which only fires for a handle whose attached interrupt handler declares
   * itself as owning a live background process, leaving every other
   * `AgentExecutionHandle` (root/native-subagent runs, loop-level interrupts)
   * untouched (#8155).
   */
  killBackgroundProcesses(): void {
    for (const [executionId, handle] of this.handles) {
      if (handle instanceof ProcessExecutionHandle) {
        this.kill(executionId);
      } else if (handle instanceof AgentExecutionHandle) {
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
  detachActiveChildren(
    parentStreamId: StreamTabId,
    _runtimeHost: AgentRuntimeHost,
    visited: Set<string> = new Set(),
  ): void {
    for (const handle of this.handles.values()) {
      if (!isChildExecution(handle, parentStreamId)) continue;
      if (handle instanceof AgentExecutionHandle) {
        handle.detach();
        this.emitParentStreamUpdate({
          childStreamId: handle.childStreamId,
          parentStreamId: null,
        });
      } else if (handle instanceof ProcessExecutionHandle) {
        this.terminate(handle, visited, { cascadeChildren: false });
      }
    }
    this.emitChildActivity(parentStreamId, 'subagents');
  }

  /**
   * Stop a visible agent stream and apply the same child policy everywhere.
   *
   * Hosts should call this instead of reconstructing stop behavior from
   * child-interrupts, root interrupts, and stream-status writes.
   */
  stopAgentStream(
    streamId: StreamTabId,
    options: StopAgentStreamOptions = {},
  ): StopAgentStreamResult {
    const rootHandle = this.getAgentHandleByStream(streamId);
    const runtimeHost = options.runtimeHost ?? rootHandle?.runtimeHost;
    const childPolicy =
      options.detachActiveChildren === true ? 'detach' : 'cascade';
    // Shared across the child sweep and the root cascade so each execution in
    // the chain is interrupted exactly once.
    const visited = new Set<string>();

    if (options.detachActiveChildren === true) {
      if (!runtimeHost) {
        return {
          kind: 'missing_runtime_host',
          streamId,
          childPolicy: 'detach',
        };
      }
      this.detachActiveChildren(streamId, runtimeHost, visited);
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
    if (stopped) {
      return { kind: 'interrupted', streamId, childPolicy };
    }
    if (!runtimeHost) {
      return { kind: 'no_target', streamId, childPolicy };
    }
    this.cancelStreamStatus(streamId);
    return { kind: 'marked_stopped', streamId, childPolicy };
  }

  /** Get active subagent and process children for a parent stream. */
  getActiveChildren(parentStreamId: StreamTabId): {
    subagents: ActiveChildInfo[];
    processes: ActiveChildInfo[];
  } {
    return {
      subagents: this.collectChildSummary(parentStreamId, AgentExecutionHandle),
      processes: this.collectChildSummary(
        parentStreamId,
        ProcessExecutionHandle,
      ),
    };
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

  /**
   * Observe the current handle immediately, then every replacement or removal.
   * Registering before the initial read closes the usual get/listen race.
   */
  observeHandle(
    executionId: string,
    cb: (handle: ExecutionHandle | undefined) => void,
  ): () => void {
    const detach = this.addListener(executionId, cb);
    cb(this.handles.get(executionId));
    return detach;
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

  private emitChildActivity(
    parentStreamId: StreamTabId,
    kind: 'subagents' | 'processes',
  ): void {
    const items = this.collectChildSummary(
      parentStreamId,
      kind === 'subagents' ? AgentExecutionHandle : ProcessExecutionHandle,
    );
    this.requireSessionEvents().emit({
      scope: 'run',
      streamId: parentStreamId,
      event:
        kind === 'subagents'
          ? {
              type: 'child.activity',
              kind: 'subagents',
              parentStreamId,
              children: items,
            }
          : {
              type: 'child.activity',
              kind: 'processes',
              parentStreamId,
              processes: items,
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
        'ExecutionRegistry child/process updates require SessionEventHub',
      );
    }
    return this.events;
  }

  private collectChildSummary(
    parentStreamId: StreamTabId,
    ctor: typeof AgentExecutionHandle | typeof ProcessExecutionHandle,
  ): ActiveChildInfo[] {
    const result: ActiveChildInfo[] = [];
    for (const handle of this.handles.values()) {
      if (
        !(handle instanceof ctor) ||
        !isChildExecution(handle, parentStreamId)
      ) {
        continue;
      }
      const { status, elapsed } = this.getStatus(handle);
      const summaryStatus =
        status === STREAM_PHASE.CANCELLED ? STREAM_STATUS.STOPPED : status;
      const base = {
        executionId: handle.executionId,
        agentName: handle.agentName,
        status: summaryStatus,
        startedAt: handle.startedAt,
        elapsed: elapsed ?? null,
        ...(handle.toolName ? { toolName: handle.toolName } : {}),
      };
      const info: ActiveChildInfo =
        handle instanceof AgentExecutionHandle
          ? { ...base, kind: 'subagent', childStreamId: handle.childStreamId }
          : { ...base, kind: 'process' };
      result.push(info);
    }
    return result;
  }

  private hasActiveChildren(parentStreamId: StreamTabId): boolean {
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

    if (handle instanceof ProcessExecutionHandle) {
      return handle.terminate();
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
   * `resumeQueuedToolUseSnapshot` flips `streamStatus` to RUNNING with a
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
    handle.trace?.emit(cancelledResult);
    this.publishResult?.(cancelledResult, handle.childStreamId);
    handle.settleResult(cancelledResult);
    const statusWrite = writeTerminalStatus(
      handle.executionId,
      projectRunOutcome(RUN_OUTCOME.CANCELLED).executionStatus,
    );
    // No later result write is guaranteed here, including during RESUMING:
    // the resume can fail before installing its own handle, while this method
    // untracks the suspended one below. Align the interim envelope only after
    // durable terminal metadata exists. A turn that does continue will replace
    // it with its own result.
    void statusWrite.then(() =>
      synchronizeAgentResultOutcome(handle.executionId, RUN_OUTCOME.CANCELLED),
    );
    this.untrackHandle(handle);
    this.cancelStreamStatus(handle.childStreamId, handle);
    return true;
  }

  private streamStatusEmitOptions(
    handle?: AgentExecutionHandle,
  ): StreamStatusEmitOptions {
    if (handle?.trace) return { trace: handle.trace };
    return this.events ? { events: this.events } : {};
  }

  /**
   * Mark a stream CANCELLED from a user stop. Routes the status emission through
   * the handle's trace when one is available and falls back to the registry's
   * SessionEventHub otherwise (see {@link streamStatusEmitOptions}).
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
}
