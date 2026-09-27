import type { RunRegistry } from '@agent/runtime/runRegistry';

import { AgentCliSessionRegistry } from './agentCliSessionRegistry';

/**
 * Owns the two stores (`codexThreadsFor`, `claudeAgentSessionsFor`) that hold
 * each session's live agent-CLI registries, keyed by that session's `Runs`.
 */

// Keyed by the session's runs (the childRunBudget WeakMap model): each
// session owns its own codex/claude registry, and a registry dies with its
// session instead of living as a process singleton.
function sessionRegistries(): (runs: RunRegistry) => AgentCliSessionRegistry {
  const registries = new WeakMap<RunRegistry, AgentCliSessionRegistry>();
  return (runs) => {
    let registry = registries.get(runs);
    if (!registry) {
      registry = new AgentCliSessionRegistry(runs);
      registries.set(runs, registry);
    }
    return registry;
  };
}

/** The session's registry of live codex threads. */
export const codexThreadsFor = sessionRegistries();

/** The session's registry of live claude-agent sessions. */
export const claudeAgentSessionsFor = sessionRegistries();
