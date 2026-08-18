import { agentName } from '../schemas/agent';

/** Bundled tool-use agent that runs the agent-led setup conversation. */
export const SETUP_AGENT_NAME = 'setup';

/**
 * Remote-catalog orchestrator roots that delegate to a team. They need
 * sign-in, so UIs surface them first.
 */
const REMOTE_ORCHESTRATOR_AGENT_NAMES = [
  'orchestrator',
  'leanOrchestrator',
] as const;

/**
 * Bundled (local) orchestrator roots that delegate to a team. Unlike the
 * remote-catalog roots above, these ship in the extension/CLI and are
 * available offline without sign-in.
 */
const BUNDLED_ORCHESTRATOR_AGENT_NAMES = ['engineer'] as const;

/** Built-in delegating team roots, remote-catalog plus bundled. */
export const BUILTIN_TEAM_ROOT_AGENT_NAMES = [
  ...REMOTE_ORCHESTRATOR_AGENT_NAMES,
  ...BUNDLED_ORCHESTRATOR_AGENT_NAMES,
] as const;

/**
 * Preferred tool-use agents for dropdown fallback and sorting.
 * Remote orchestrators come first, then bundled orchestrators, then general
 * and task-flavored fallbacks for users without sign-in.
 */
export const PREFERRED_TOOL_USE_AGENTS = [
  ...BUILTIN_TEAM_ROOT_AGENT_NAMES,
  'assistant',
  'research',
  'review',
] as const;

// Agents that exist in the catalog but must never be auto-selected as the
// implicit chat default — e.g. `simplifier` is a code utility, not a chat
// partner. They remain available when chosen explicitly with `--agent`.
const NON_DEFAULT_TOOL_USE_AGENTS = new Set(['simplifier']);

/** Whether `agent` may be chosen as the implicit default tool-use agent. */
export function isImplicitDefaultEligible(agent: string): boolean {
  return !NON_DEFAULT_TOOL_USE_AGENTS.has(
    agentName(agent.trim()).toLowerCase(),
  );
}

/** The subset of `agents` eligible to be the implicit default. */
export function implicitDefaultToolUseAgents<
  T extends { readonly name: string },
>(agents: readonly T[]): T[] {
  return agents.filter((agent) => isImplicitDefaultEligible(agent.name));
}
