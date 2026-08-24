import {
  forEachLiveSession,
  killAllSessionBackgroundProcesses,
  settleLiveSessionExecutions,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { SHUTDOWN_PHASE, type LifecycleHost } from '@platform/interfaces';

import { AgentCliSessionRegistry } from './agentCliSessionRegistry';

// Session-keyed (the childRunBudget WeakMap model): each session owns its own
// codex/claude registry, so per-session teardown interrupts exactly its own
// agent-CLI children and a registry dies with its session instead of living
// as a process singleton.
function sessionRegistries(persistedSessionKey: string) {
  const registries = new WeakMap<SessionHandle, AgentCliSessionRegistry>();
  return {
    registries,
    for: (session: SessionHandle): AgentCliSessionRegistry => {
      let registry = registries.get(session);
      if (!registry) {
        registry = new AgentCliSessionRegistry(persistedSessionKey);
        registries.set(session, registry);
      }
      return registry;
    },
  };
}

const codexThreads = sessionRegistries('codex_thread_id');
const claudeAgentSessions = sessionRegistries('claude_agent_session_id');

/** The session's registry of live codex threads. */
export const codexThreadsFor = codexThreads.for;

/** The session's registry of live claude-agent sessions. */
export const claudeAgentSessionsFor = claudeAgentSessions.for;

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
      codexThreads.registries.get(session)?.interruptAll();
      claudeAgentSessions.registries.get(session)?.interruptAll();
    });
  });
}

type ShutdownHandler = (signal: AbortSignal) => void | Promise<void>;

export interface RuntimeShutdownHooks {
  /** BEFORE handlers that must run before agent processes are interrupted. */
  readonly beforeAgentShutdown?: readonly ShutdownHandler[];
  /** BEFORE handlers between agent interruption and artifact persistence. */
  readonly afterAgentShutdown?: readonly ShutdownHandler[];
  /** Persist the host's process/session artifacts. */
  readonly flushArtifacts: ShutdownHandler;
  /** BEFORE handlers that require artifact persistence to have finished. */
  readonly afterFlushArtifacts?: readonly ShutdownHandler[];
  /** ON handlers that run after live executions have settled. */
  readonly afterExecutionSettlement?: readonly ShutdownHandler[];
}

/** Register the cross-host runtime shutdown order with named host hooks. */
export function registerRuntimeShutdownHandlers(
  lifecycle: LifecycleHost,
  hooks: RuntimeShutdownHooks,
): void {
  registerHandlers(lifecycle, SHUTDOWN_PHASE.BEFORE, hooks.beforeAgentShutdown);
  registerAgentShutdownHandlers(lifecycle);
  registerHandlers(lifecycle, SHUTDOWN_PHASE.BEFORE, hooks.afterAgentShutdown);
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, hooks.flushArtifacts);
  registerHandlers(lifecycle, SHUTDOWN_PHASE.BEFORE, hooks.afterFlushArtifacts);
  lifecycle.onShutdown(SHUTDOWN_PHASE.ON, (signal) =>
    settleLiveSessionExecutions(signal),
  );
  registerHandlers(
    lifecycle,
    SHUTDOWN_PHASE.ON,
    hooks.afterExecutionSettlement,
  );
}

function registerHandlers(
  lifecycle: LifecycleHost,
  phase: (typeof SHUTDOWN_PHASE)[keyof typeof SHUTDOWN_PHASE],
  handlers: readonly ShutdownHandler[] | undefined,
): void {
  for (const handler of handlers ?? []) lifecycle.onShutdown(phase, handler);
}
