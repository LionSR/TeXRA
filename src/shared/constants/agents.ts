/** Bundled tool-use agent that runs the agent-led setup conversation. */
export const SETUP_AGENT_NAME = 'setup';

/**
 * Relay-served orchestrator roots that delegate to a team. They need sign-in,
 * so UIs surface them first.
 */
const REMOTE_ORCHESTRATOR_AGENT_NAMES = [
  'orchestrator',
  'leanOrchestrator',
] as const;

/**
 * Bundled (local) orchestrator roots that delegate to a team. Unlike the
 * relay-served roots above, these ship in the extension/CLI and are available
 * offline without sign-in.
 */
const BUNDLED_ORCHESTRATOR_AGENT_NAMES = ['engineer'] as const;

/** Built-in delegating team roots, relay-served plus bundled. */
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
