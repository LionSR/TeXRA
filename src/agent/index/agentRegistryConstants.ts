/** Source priorities and preferred-agent lists for the agent registry. */

import type { AgentSource } from '@shared/schemas/agent';
export {
  BUNDLED_ORCHESTRATOR_AGENT_NAMES,
  BUILTIN_TEAM_ROOT_AGENT_NAMES,
  PREFERRED_TOOL_USE_AGENTS,
  REMOTE_ORCHESTRATOR_AGENT_NAMES,
} from '@shared/constants/agents';

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
