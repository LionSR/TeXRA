import {
  SHUTDOWN_PHASE,
  type LifecycleHost,
} from '@platform/interfaces/lifecycle';
import {
  ClaudeAgentSessions,
  CodexThreads,
} from '@tools/agentCliSessionStores';

import { SharedExecutionRegistry } from './executionRegistry';

/**
 * Stops agent-spawned child processes and CLI-backed agent sessions before
 * host teardown. Every long-lived host (VS Code extension, Electron desktop)
 * registers these so agent work never outlives the host.
 */
export function registerAgentShutdownHandlers(lifecycle: LifecycleHost): void {
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
    SharedExecutionRegistry.killBackgroundProcesses(),
  );
  // Interrupt CLI-backed sessions so their streams don't reload in a stale
  // WAITING state.
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
    CodexThreads.interruptAll(),
  );
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
    ClaudeAgentSessions.interruptAll(),
  );
}
