/**
 * Generic stream-scoped approval controller, owned per session.
 *
 * Encapsulates the shared concerns of bash and tool-edit approvals:
 *   - serialized request queues (one prompt at a time per stream)
 *   - registry of in-flight pending approvals keyed by request id
 *   - per-stream bypass state announced over a bound progress event
 *   - rejection on stream cleanup
 *
 * Parameterized by the approval result type so each controller can carry
 * domain-specific result fields (e.g. tool-edit appliedContent / userPatch).
 *
 * Controller instances live on {@link SessionApprovals}, one per
 * `SessionHandle` (#8144) — there is no process-global controller, so two
 * sessions queue, resolve, and clean up approvals independently.
 */

import PQueue from 'p-queue';

import type { StreamTabId } from '@shared/schemas';
import type { ToolEditApprovalResult } from '@platform/interfaces';

import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { HostBashApprovalResult } from './HostInteractions';

/** Progress events that announce per-stream approval-bypass changes. */
export type ApprovalBypassEvent =
  | 'updateToolEditApprovalBypassState'
  | 'updateBashApprovalBypassState'
  | 'updateSuperYoloBypassState';

/**
 * Per-stream bypass state bound to the progress event that announces it.
 *
 * Single implementation behind the tool-edit, bash, and proposal (super-YOLO)
 * bypass toggles, so set/toggle/clear semantics and UI notification stay
 * uniform across approval kinds.
 *
 * A stream with no explicit bypass value of its own defers to its ancestor
 * chain (see `resolveParent`) rather than defaulting straight to `false` —
 * this is what lets a delegated subagent stream, or the next round of a CLI
 * conversation, inherit a bypass its predecessor turned on, without a
 * one-shot copy that misses toggles made after the child/round was created.
 */
export interface StreamApprovalBypass {
  isBypassed(streamId: StreamTabId): boolean;
  /**
   * Set bypass for a stream. Emits the bound progress event when a
   * `runtimeHost` is provided (unless `silent`); omit the host for
   * pre-activation setup where no UI exists yet.
   */
  setBypass(
    streamId: StreamTabId,
    enabled: boolean,
    runtimeHost?: AgentRuntimeHost,
    options?: { silent?: boolean },
  ): void;
  /** Toggle per-stream bypass, announce it, and return the new state. */
  toggleBypass(streamId: StreamTabId, runtimeHost: AgentRuntimeHost): boolean;
  clearForStream(streamId: StreamTabId): void;
  clearAll(): void;
}

export function createStreamApprovalBypass(
  event: ApprovalBypassEvent,
  resolveParent: (streamId: StreamTabId) => StreamTabId | undefined,
): StreamApprovalBypass {
  const byStream = new Map<StreamTabId, boolean>();

  const setBypass: StreamApprovalBypass['setBypass'] = (
    streamId,
    enabled,
    runtimeHost,
    options,
  ) => {
    byStream.set(streamId, enabled);
    if (runtimeHost && !options?.silent) {
      runtimeHost.emit(event, { streamId, bypassActive: enabled });
    }
  };

  return {
    isBypassed(streamId) {
      const seen = new Set<StreamTabId>();
      let current: StreamTabId | undefined = streamId;
      while (current && !seen.has(current)) {
        const explicit = byStream.get(current);
        if (explicit !== undefined) return explicit;
        seen.add(current);
        current = resolveParent(current);
      }
      return false;
    },
    setBypass,
    toggleBypass(streamId, runtimeHost) {
      const next = !byStream.get(streamId);
      setBypass(streamId, next, runtimeHost);
      return next;
    },
    clearForStream(streamId) {
      byStream.delete(streamId);
    },
    clearAll() {
      byStream.clear();
    },
  };
}

export interface PendingApproval<R extends { accepted: boolean }> {
  streamId?: StreamTabId;
  isSettled: () => boolean;
  settle: (result: R) => void;
}

export interface StreamApprovalController<R extends { accepted: boolean }> {
  registerPending(id: string, entry: PendingApproval<R>): void;
  unregisterPending(id: string): void;
  bypass: StreamApprovalBypass;
  enqueue<T>(
    streamId: StreamTabId | undefined,
    run: () => Promise<T>,
  ): Promise<T>;
  rejectPendingForStream(streamId: StreamTabId): void;
  /**
   * Reject pending entries with no concrete stream context (streamId is
   * undefined or empty). The controller is session-owned, so this never
   * reaches another session's streamless approvals.
   */
  rejectUnscopedPending(): void;
  rejectAllPending(): void;
}

export interface StreamApprovalControllerOptions<
  R extends { accepted: boolean },
> {
  rejectionResult: () => R;
  bypassEvent: ApprovalBypassEvent;
  resolveParent: (streamId: StreamTabId) => StreamTabId | undefined;
}

export function createStreamApprovalController<R extends { accepted: boolean }>(
  options: StreamApprovalControllerOptions<R>,
): StreamApprovalController<R> {
  const pending = new Map<string, PendingApproval<R>>();
  const queues = new Map<StreamTabId | undefined, PQueue>();

  function rejectWhere(
    predicate: (entry: PendingApproval<R>) => boolean,
  ): void {
    for (const entry of pending.values()) {
      if (!entry.isSettled() && predicate(entry)) {
        entry.settle(options.rejectionResult());
      }
    }
  }

  return {
    registerPending(id, entry) {
      pending.set(id, entry);
    },
    unregisterPending(id) {
      pending.delete(id);
    },
    bypass: createStreamApprovalBypass(
      options.bypassEvent,
      options.resolveParent,
    ),
    enqueue<T>(
      streamId: StreamTabId | undefined,
      run: () => Promise<T>,
    ): Promise<T> {
      let queue = queues.get(streamId);
      if (!queue) {
        queue = new PQueue({ concurrency: 1 });
        queues.set(streamId, queue);
      }

      // `add` widens to `T | void` to cover abort via signal/timeout; we pass
      // neither, so the task always runs and resolves with `T`.
      const task = queue.add(run) as Promise<T>;
      return task.finally(() => {
        if (
          queue.pending === 0 &&
          queue.size === 0 &&
          queues.get(streamId) === queue
        ) {
          queues.delete(streamId);
        }
      });
    },
    rejectPendingForStream(streamId) {
      rejectWhere((entry) => entry.streamId === streamId);
    },
    rejectUnscopedPending() {
      rejectWhere((entry) => !entry.streamId);
    },
    rejectAllPending() {
      rejectWhere(() => true);
    },
  };
}

/**
 * Session-owned approval state: the tool-edit and bash controllers plus the
 * delegation-proposal (super-YOLO) bypass. One instance per `SessionHandle`
 * (`session.approvals`); run-scoped code resolves it through
 * `currentSession()`, host code passes its own session explicitly.
 */
export interface SessionApprovals {
  readonly toolEdit: StreamApprovalController<ToolEditApprovalResult>;
  readonly bash: StreamApprovalController<HostBashApprovalResult>;
  /**
   * Per-stream bypass for agent delegation proposals (super-YOLO). Proposals
   * settle through the run coordinators rather than a stream approval queue,
   * so unlike bash / tool-edit there is no controller — only bypass state.
   */
  readonly proposal: StreamApprovalBypass;
  /**
   * Record that `childStreamId` descends from `parentStreamId` for bypass
   * resolution purposes: `toolEdit`/`bash`/`proposal.isBypassed(childStreamId)`
   * will defer to the parent's bypass state whenever the child has no
   * explicit value of its own. Used for delegated subagent streams (parent =
   * the orchestrator stream) and, in the CLI, successive conversation rounds
   * (parent = the previous round's root stream) — both mint a fresh
   * `StreamTabId` that would otherwise start every bypass kind ungated.
   */
  registerStreamParent(
    childStreamId: StreamTabId,
    parentStreamId: StreamTabId,
  ): void;
  /**
   * Reject every pending approval and clear all bypass + proposal state for
   * this session. Used by session teardown and the session-wide
   * `cleanupAllApprovals` sweep.
   */
  rejectAndClearAll(): void;
}

export function createSessionApprovals(): SessionApprovals {
  const parentOf = new Map<StreamTabId, StreamTabId>();
  const resolveParent = (streamId: StreamTabId): StreamTabId | undefined =>
    parentOf.get(streamId);

  const toolEdit = createStreamApprovalController<ToolEditApprovalResult>({
    rejectionResult: () => ({ accepted: false }),
    bypassEvent: 'updateToolEditApprovalBypassState',
    resolveParent,
  });
  const bash = createStreamApprovalController<HostBashApprovalResult>({
    rejectionResult: () => ({ accepted: false }),
    bypassEvent: 'updateBashApprovalBypassState',
    resolveParent,
  });
  const proposal = createStreamApprovalBypass(
    'updateSuperYoloBypassState',
    resolveParent,
  );
  return {
    toolEdit,
    bash,
    proposal,
    registerStreamParent(childStreamId, parentStreamId) {
      parentOf.set(childStreamId, parentStreamId);
    },
    rejectAndClearAll() {
      toolEdit.rejectAllPending();
      bash.rejectAllPending();
      toolEdit.bypass.clearAll();
      bash.bypass.clearAll();
      proposal.clearAll();
      parentOf.clear();
    },
  };
}
