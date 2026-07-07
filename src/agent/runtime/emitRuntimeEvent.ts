/**
 * Single emit path for session-scoped runtime facts.
 *
 * One session fact has one emit path and one name, resolving the target in
 * priority order:
 *
 * 1. a host-path caller's explicit `session`;
 * 2. the active run's `RunContext.session`;
 * 3. the process default session used by the VS Code extension and CLI.
 *
 * Host/RPC events must use the owning `AgentRuntimeHost.emit` directly. This
 * helper accepts only `SessionFact` arms — there is no process-bus fallback
 * and no runtime dispatch for non-session events.
 */
import { tryUseRunContext } from './RunContext';
import { defaultSession, type SessionHandle } from './SessionHandle';
import type { SessionFact } from './SessionEventHub';

export function emitRuntimeEvent<K extends SessionFact['type']>(
  event: K,
  payload: Extract<SessionFact, { type: K }>['payload'],
  session?: SessionHandle,
): void {
  // A run context may carry a partial session without an event hub; fall
  // back to the process default session in that case (pre-existing contract).
  const owner = session ?? tryUseRunContext()?.session;
  const target = owner?.events ? owner : defaultSession();
  target.events.emit({
    scope: 'session',
    event: { type: event, payload } as SessionFact,
  });
}
