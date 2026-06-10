// Local imports - platform
import {
  SHUTDOWN_PHASE,
  type LifecycleHost,
} from '@platform/interfaces/lifecycle';

// Local imports - tools
import {
  interruptAllClaudeAgentSessions,
  interruptAllCodexSessions,
} from '@tools/agentCliSessionStores';

// Local imports - runtime
import { executionRegistry } from './executionRegistry';

/**
 * Stops agent-spawned child processes and CLI-backed agent sessions before
 * host teardown. Every long-lived host (VS Code extension, Electron desktop)
 * registers these so agent work never outlives the host.
 */
export function registerAgentShutdownHandlers(lifecycle: LifecycleHost): void {
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
    executionRegistry.killBackgroundProcesses(),
  );
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
    interruptAllCodexSessions(),
  );
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
    interruptAllClaudeAgentSessions(),
  );
}
