import {
  forEachLiveSession,
  killAllSessionBackgroundProcesses,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { SHUTDOWN_PHASE, type LifecycleHost } from '@platform/interfaces';

import { AgentCliSessionRegistry } from './agentCliSessionRegistry';

// Session-keyed (the childRunBudget WeakMap model): each session owns its own
// codex/claude registry, so per-session teardown interrupts exactly its own
// agent-CLI children and a registry dies with its session instead of living
// as a process singleton.
const codexThreads = new WeakMap<SessionHandle, AgentCliSessionRegistry>();
const claudeAgentSessions = new WeakMap<
  SessionHandle,
  AgentCliSessionRegistry
>();

function registryFor(
  registries: WeakMap<SessionHandle, AgentCliSessionRegistry>,
  session: SessionHandle,
  persistedSessionKey: string,
): AgentCliSessionRegistry {
  let registry = registries.get(session);
  if (!registry) {
    registry = new AgentCliSessionRegistry(persistedSessionKey);
    registries.set(session, registry);
  }
  return registry;
}

/** The session's registry of live codex threads. */
export function codexThreadsFor(session: SessionHandle): AgentCliSessionRegistry {
  return registryFor(codexThreads, session, 'codex_thread_id');
}

/** The session's registry of live claude-agent sessions. */
export function claudeAgentSessionsFor(
  session: SessionHandle,
): AgentCliSessionRegistry {
  return registryFor(claudeAgentSessions, session, 'claude_agent_session_id');
}

/**
 * Register host shutdown handlers that stop agent work at teardown: kill the
 * background OS processes owned by live runtime sessions and interrupt any
 * agent-CLI codex/claude sessions those sessions still track. Lives here —
 * next to the registries it interrupts — because the hosts import it once
 * during platform startup and the core never depends on tool-layer teardown
 * wiring.
 */
export function registerAgentShutdownHandlers(lifecycle: LifecycleHost): void {
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
    killAllSessionBackgroundProcesses(),
  );
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () => {
    forEachLiveSession((session) => {
      codexThreads.get(session)?.interruptAll();
      claudeAgentSessions.get(session)?.interruptAll();
    });
  });
}
