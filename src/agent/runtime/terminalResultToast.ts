/**
 * Session hooks for hosts that present failures from terminal results.
 * Shared error guidance comes from `agentErrorPresentation`. Subagent results
 * and outcomes without error metadata do not produce a notification.
 */
import type { ResultEvent } from '@agent/trace';
import { agentErrorPresentation } from '@common/errors/agentErrorClassification';

import type { SessionHostInteractions } from './HostInteractions';
import type { SessionHandle } from './SessionHandle';

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
      (!event.isSubagent &&
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
    if (event.isSubagent || !event.error) return;
    const toast = agentErrorPresentation(event.error);
    if (toast?.type === 'instruction') {
      interactions.emit('requestShowInstruction', toast.payload, options);
    } else if (toast?.type === 'error') {
      interactions.emit('requestShowError', toast.payload, options);
    }
  });
}
