export const BUILTIN_DEFAULT_CHAT_AGENT = 'chat';

const NON_DEFAULT_TOOL_USE_AGENTS = new Set(['simplifier']);

export function isDefaultToolUseAgentAllowed(agent: string): boolean {
  return !NON_DEFAULT_TOOL_USE_AGENTS.has(agent.trim().toLowerCase());
}

export function defaultToolUseAgents<T extends { readonly name: string }>(
  agents: readonly T[],
): T[] {
  return agents.filter((agent) => isDefaultToolUseAgentAllowed(agent.name));
}

export function normalizeDefaultToolUseAgent(
  agent: string | undefined,
): string | undefined {
  const trimmed = agent?.trim();
  if (!trimmed || !isDefaultToolUseAgentAllowed(trimmed)) return undefined;
  return trimmed;
}
