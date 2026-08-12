
import { killAllSessionBackgroundProcesses } from '@agent/runtime/SessionHandle';
import { SHUTDOWN_PHASE, type LifecycleHost } from '@platform/interfaces';
import type {
  ClaudeAgentEffort,
  ClaudeAgentPermissionMode,
} from '@shared/schemas';

import {
  AgentCliSessionRegistry,
  type AgentCliSessionEntry,
} from './agentCliSessionRegistry';
import type { Thread } from '@openai/codex-sdk';

export interface ActiveCodexThread extends AgentCliSessionEntry {
  thread: Thread;
}

export interface ActiveClaudeAgentSession extends AgentCliSessionEntry {
  model: string;
  permissionMode: ClaudeAgentPermissionMode;
  effort: ClaudeAgentEffort;
  cwd?: string;
  additionalDirectories?: string[];
}

export const CodexThreads = new AgentCliSessionRegistry<ActiveCodexThread>(
  'codex_thread_id',
);

export const ClaudeAgentSessions =
  new AgentCliSessionRegistry<ActiveClaudeAgentSession>(
    'claude_agent_session_id',
  );

/**
 * Register host shutdown handlers that stop agent work at teardown: kill the
 * background OS processes owned by live runtime sessions and interrupt any
 * agent-CLI codex/claude sessions this host still tracks. Lives here — next to
 * the registries it interrupts — because the hosts import it once during
 * platform startup and the core never depends on tool-layer teardown wiring.
 */
export function registerAgentShutdownHandlers(lifecycle: LifecycleHost): void {
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
    killAllSessionBackgroundProcesses(),
  );
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
    CodexThreads.interruptAll(),
  );
  lifecycle.onShutdown(SHUTDOWN_PHASE.BEFORE, () =>
    ClaudeAgentSessions.interruptAll(),
  );
}
