/**
 * Session hooks for hosts that present failures from terminal results.
 * Shared error guidance comes from `agentErrorPresentation`. Child results
 * and outcomes without error metadata do not produce a notification.
 */
import { SubscriptionRef } from 'effect';

import type { ResultEvent } from '@agent/trace';
import { agentErrorPresentation } from '@common/errors/agentErrorClassification';

import type { SessionHostInteractions } from './HostInteractions';
import type { SessionHandle } from './SessionHandle';

/**
 * Whether a terminal result belongs to a child run: the handle's parent edge
 * while the run is tracked (a result is emitted before untrack), else the
 * fold's, which has the run's `run.start` for a launch that failed before a
 * handle existed.
 */
function isChildResult(session: SessionHandle, event: ResultEvent): boolean {
  const handle = session.runs.getHandle(event.runId);
  if (handle) return handle.isChild;
  const run = SubscriptionRef.getUnsafe(session.view).runs.get(event.runId);
  return run !== undefined && run.parentId !== null;
}

/**
 * Track whether a matching terminal result has already claimed failure
 * presentation for a caller that otherwise needs a direct fallback.
 */
export function trackTerminalResultPresentation(
  session: SessionHandle,
  matches: (event: ResultEvent) => boolean,
): {
  reportUnhandled<T>(report: () => T): T | undefined;
  dispose(): void;
} {
  let handled = false;
  const dispose = session.onResult((event) => {
    if (!matches(event)) return;
    handled =
      event.error?.kind === 'abort' ||
      (!isChildResult(session, event) &&
        event.error !== undefined &&
        agentErrorPresentation(event.error) !== null);
  });
  return {
    reportUnhandled: (report) => (handled ? undefined : report()),
    dispose,
  };
}

/** Returns a detach disposer; callers detach when the run/host tears down. */
export function attachTerminalResultToast(
  session: SessionHandle,
  interactions: SessionHostInteractions,
  options: { replayWhenAttached?: boolean } = {},
): () => void {
  return session.onResult((event) => {
    if (!event.error || isChildResult(session, event)) return;
    const toast = agentErrorPresentation(event.error);
    if (toast?.type === 'instruction') {
      interactions.emit('requestShowInstruction', toast.payload, options);
    } else if (toast?.type === 'error') {
      interactions.emit('requestShowError', toast.payload, options);
    }
  });
}
