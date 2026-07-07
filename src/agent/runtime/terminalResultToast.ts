/**
 * Attach a terminal-error toast presenter to a session for hosts that present
 * through an {@link AgentRuntimeHost} (CLI, desktop). The lifecycle no longer
 * emits these toasts directly — it emits one `result` event, and this bridges
 * that event to the host's existing `requestShowInstruction` / `requestShowError`
 * path via the shared {@link terminalResultToast} mapper.
 *
 * The `session` is load-bearing: desktop passes its per-window session, while
 * CLI/extension pass the process {@link defaultSession}. A helper that
 * hard-coded the default would route desktop to the wrong session and never see
 * its results. Every host presents through its `runtimeHost` — including the
 * extension, whose `extensionAgentRuntimeHost.emit` is `ProgressEventBus.emit`,
 * so the `requestShow*` events reach the same `ProgressEventBus.on` handlers
 * exactly once.
 */
import { terminalResultToast } from '@shared/agent/terminalResultPresentation';

import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { SessionHandle } from './SessionHandle';

/** Returns a detach disposer; callers detach when the run/host tears down. */
export function attachTerminalResultToast(
  session: SessionHandle,
  runtimeHost: AgentRuntimeHost,
): () => void {
  return session.onResult((event) => {
    const toast = terminalResultToast(event);
    if (toast?.type === 'instruction') {
      runtimeHost.emit('requestShowInstruction', toast.payload);
    } else if (toast?.type === 'error') {
      runtimeHost.emit('requestShowError', toast.payload);
    }
  });
}
