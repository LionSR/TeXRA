/**
 * Generic stream-scoped approval controller.
 *
 * Encapsulates the shared concerns of bash and tool-edit approvals:
 *   - serialized request queue (one prompt at a time)
 *   - registry of in-flight pending approvals keyed by request id
 *   - per-stream bypass state announced over a bound progress event
 *   - rejection on stream cleanup
 *
 * Parameterized by the approval result type so each controller can carry
 * domain-specific result fields (e.g. tool-edit appliedContent / userPatch).
 */

import PQueue from 'p-queue';

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { StreamTabId } from '@shared/schemas';

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
      return byStream.get(streamId) ?? false;
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
  runtimeHost?: AgentRuntimeHost;
  isSettled: () => boolean;
  settle: (result: R) => void;
}

export interface StreamApprovalController<R extends { accepted: boolean }> {
  registerPending(id: string, entry: PendingApproval<R>): void;
  unregisterPending(id: string): void;
  getPending(id: string): PendingApproval<R> | undefined;
  bypass: StreamApprovalBypass;
  enqueue<T>(run: () => Promise<T>): Promise<T>;
  rejectPendingForStream(streamId: StreamTabId): void;
  /**
   * Reject pending entries with no concrete stream context. When `runtimeHost`
   * is provided, only rejects entries owned by that host.
   */
  rejectUnscopedPending(runtimeHost?: AgentRuntimeHost): void;
  rejectAllPending(): void;
}

export interface StreamApprovalControllerOptions<
  R extends { accepted: boolean },
> {
  rejectionResult: () => R;
  bypassEvent: ApprovalBypassEvent;
}

export function createStreamApprovalController<R extends { accepted: boolean }>(
  options: StreamApprovalControllerOptions<R>,
): StreamApprovalController<R> {
  const pending = new Map<string, PendingApproval<R>>();
  // Serialize approvals so only one prompt is in flight at a time.
  const queue = new PQueue({ concurrency: 1 });

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
    getPending(id) {
      return pending.get(id);
    },
    bypass: createStreamApprovalBypass(options.bypassEvent),
    enqueue<T>(run: () => Promise<T>): Promise<T> {
      // `add` widens to `T | void` to cover abort via signal/timeout; we pass
      // neither, so the task always runs and resolves with `T`.
      return queue.add(run) as Promise<T>;
    },
    rejectPendingForStream(streamId) {
      rejectWhere((entry) => entry.streamId === streamId);
    },
    rejectUnscopedPending(runtimeHost) {
      rejectWhere(
        (entry) =>
          !entry.streamId &&
          (runtimeHost === undefined || entry.runtimeHost === runtimeHost),
      );
    },
    rejectAllPending() {
      rejectWhere(() => true);
    },
  };
}
