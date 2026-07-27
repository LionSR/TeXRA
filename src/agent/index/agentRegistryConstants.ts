/** Source priorities and preferred-agent lists for the agent registry. */

import type { AgentSource } from '@shared/schemas/agent';
export {
  BUILTIN_TEAM_ROOT_AGENT_NAMES,
  PREFERRED_TOOL_USE_AGENTS,
} from '@shared/constants/agents';

/**
 * Source priority for lookups (higher priority first).
 *
 * `inline` leads both lists: a definition the embedder handed the runtime as a
 * value is the most specific statement of intent, so it wins over a same-named
 * file on disk. It must be listed rather than left out — `deduplicateByName`
 * compares `indexOf`, and an absent source scores `-1`, which would rank it
 * first by accident instead of by decision.
 */
export const LOOKUP_PRIORITY: AgentSource[] = [
  'inline',
  'custom',
  'remote',
  'builtInWorkflow',
  'builtInToolUse',
];

/** Source priority for tool-use sessions (prefers tool-use agents over workflow). */
export const TOOL_USE_LOOKUP_PRIORITY: AgentSource[] = [
  'inline',
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
