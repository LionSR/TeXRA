/**
 * Attach a terminal-error toast presenter to a session for hosts that present
 * through an {@link AgentRuntimeHost} (CLI, desktop). The lifecycle no longer
 * emits these toasts directly — it emits one `result` event, and this bridges
 * that event to the host's existing `requestShowInstruction` / `requestShowError`
 * path via the shared {@link presentTerminalResult} mapper.
 *
 * The `session` is load-bearing: desktop passes its per-window session, while
 * CLI passes the process {@link defaultSession}. A helper that hard-coded the
 * default would route desktop to the wrong session and never see its results.
 */
import { presentTerminalResult } from '@shared/agent/terminalResultPresentation';

import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { SessionHandle } from './SessionHandle';

/** Returns a detach disposer; callers detach when the run/host tears down. */
export function attachTerminalResultToast(
  session: SessionHandle,
  runtimeHost: AgentRuntimeHost,
): () => void {
  return session.onResult((event) =>
    presentTerminalResult(event, {
      showInstruction: (payload) =>
        runtimeHost.emit('requestShowInstruction', payload),
      showError: (payload) => runtimeHost.emit('requestShowError', payload),
    }),
  );
}
