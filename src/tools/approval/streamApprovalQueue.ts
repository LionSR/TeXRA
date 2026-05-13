/**
 * Generic stream-scoped approval controller.
 *
 * Encapsulates the shared concerns of bash and tool-edit approvals:
 *   - serialized request queue (one prompt at a time)
 *   - registry of in-flight pending approvals keyed by request id
 *   - per-stream bypass state with optional UI notification hook
 *   - rejection on stream cleanup
 *
 * Parameterized by the approval result type so each controller can carry
 * domain-specific result fields (e.g. tool-edit appliedContent / userPatch).
 */

import type { StreamTabId } from '@shared/schemas';

export interface PendingApproval<R extends { accepted: boolean }> {
  streamId?: StreamTabId;
  isSettled: () => boolean;
  settle: (result: R) => void;
}

export interface StreamApprovalController<R extends { accepted: boolean }> {
  registerPending(id: string, entry: PendingApproval<R>): void;
  unregisterPending(id: string): void;
  getPending(id: string): PendingApproval<R> | undefined;
  isBypassed(streamId: StreamTabId): boolean;
  setBypass(streamId: StreamTabId, enabled: boolean): void;
  enqueue<T>(run: () => Promise<T>): Promise<T>;
  rejectPendingForStream(streamId: StreamTabId): void;
  rejectAllPending(): void;
  clearBypassForStream(streamId: StreamTabId): void;
  clearAllBypass(): void;
}

export interface StreamApprovalControllerOptions<
  R extends { accepted: boolean },
> {
  rejectionResult: () => R;
}

export function createStreamApprovalController<R extends { accepted: boolean }>(
  options: StreamApprovalControllerOptions<R>,
): StreamApprovalController<R> {
  const pending = new Map<string, PendingApproval<R>>();
  const bypassedByStream = new Map<StreamTabId, boolean>();
  let queue: Promise<void> = Promise.resolve();

  function rejectMatching(streamId?: StreamTabId): void {
    for (const entry of pending.values()) {
      const matches = streamId === undefined || entry.streamId === streamId;
      if (matches && !entry.isSettled()) {
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
    isBypassed(streamId) {
      return bypassedByStream.get(streamId) ?? false;
    },
    setBypass(streamId, enabled) {
      bypassedByStream.set(streamId, enabled);
    },
    enqueue(run) {
      const operation = queue.then(run);
      queue = operation.then(
        () => {},
        () => {},
      );
      return operation;
    },
    rejectPendingForStream(streamId) {
      rejectMatching(streamId);
    },
    rejectAllPending() {
      rejectMatching();
    },
    clearBypassForStream(streamId) {
      bypassedByStream.delete(streamId);
    },
    clearAllBypass() {
      bypassedByStream.clear();
    },
  };
}
