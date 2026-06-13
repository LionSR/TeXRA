import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { terminalResultToast } from '@shared/agent/terminalResultPresentation';

/**
 * Present terminal-error toasts for the active run through `runtimeHost` — the
 * same path the run lifecycle used before it stopped emitting them directly.
 * Returns a detach disposer; the CLI runs sequentially, so each run attaches on
 * start and detaches on cleanup (no overlapping consumers, no double toasts).
 */
export function attachTerminalResultToast(
  runtimeHost: AgentRuntimeHost,
): () => void {
  return defaultSession().onResult((event) => {
    const toast = terminalResultToast(event);
    if (toast?.type === 'instruction') {
      runtimeHost.emit('requestShowInstruction', toast.payload);
    } else if (toast?.type === 'error') {
      runtimeHost.emit('requestShowError', toast.payload);
    }
  });
}
