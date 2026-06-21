/** Source priorities and preferred-agent lists for the agent registry. */

import type { AgentSource } from '@shared/schemas/agent';

/** Source priority for lookups (higher priority first). */
export const LOOKUP_PRIORITY: AgentSource[] = [
  'custom',
  'remote',
  'builtInWorkflow',
  'builtInToolUse',
];

/** Source priority for tool-use sessions (prefers tool-use agents over workflow). */
export const TOOL_USE_LOOKUP_PRIORITY: AgentSource[] = [
  'custom',
  'remote',
  'builtInToolUse',
  'builtInWorkflow',
];

/**
 * Legacy agent-name aliases — keep prior configs, histories, delegation calls,
 * and inherited references working when a built-in agent is renamed.
 */
export const LEGACY_AGENT_ALIASES: Record<string, string> = {
  chat: 'assistant',
};

/** Default workflow agent when no workflow preference exists. */
export const DEFAULT_WORKFLOW_AGENT = 'correct';

/**
 * Relay-served orchestrator roots that delegate to a team. They need sign-in,
 * so UIs surface them first.
 */
export const REMOTE_ORCHESTRATOR_AGENT_NAMES = [
  'orchestrator',
  'leanOrchestrator',
] as const;

/**
 * Bundled (local) orchestrator roots that delegate to a team. Unlike the
 * relay-served roots above, these ship in the extension/CLI and are available
 * offline without sign-in (e.g. the Software Engineer team's `engineer` lead).
 */
export const BUNDLED_ORCHESTRATOR_AGENT_NAMES = ['engineer'] as const;

/**
 * Single source of truth for "the built-in delegating team roots" (relay-served
 * plus bundled). Consumed by the CLI multi-agent presets to pick a preset's
 * root agent.
 */
export const BUILTIN_TEAM_ROOT_AGENT_NAMES = [
  ...REMOTE_ORCHESTRATOR_AGENT_NAMES,
  ...BUNDLED_ORCHESTRATOR_AGENT_NAMES,
] as const;

/**
 * Preferred agents for dropdowns, in priority order.
 * Preferred agents present in the workspace are sorted to the top of the
 * dropdown (in the order listed here); all others follow alphabetically.
 * Remote orchestrators come first because they need sign-in, then bundled
 * orchestrators such as `engineer`, then `assistant` — the general-purpose
 * default for users without sign-in (State 2 of
 * docs/prds/2026-06-11-agent-native-onboarding.md) — then `research`/`review` as
 * task-flavored fallbacks. This keeps signed-out users in presets like
 * Physicist/Mathematician from landing on task-specific agents (e.g.
 * `presenter`) by alphabetical accident.
 */
export const PREFERRED_TOOL_USE_AGENTS = [
  ...REMOTE_ORCHESTRATOR_AGENT_NAMES,
  ...BUNDLED_ORCHESTRATOR_AGENT_NAMES,
  'assistant',
  'research',
  'review',
] as const;
