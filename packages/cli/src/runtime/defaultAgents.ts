import { agentName } from '@shared/schemas';

export const BUILTIN_DEFAULT_CHAT_AGENT = 'assistant';

const NON_IMPLICIT_DEFAULT_TOOL_USE_AGENTS = new Set(['simplifier']);

function isImplicitDefaultToolUseAgentAllowed(agent: string): boolean {
  return !NON_IMPLICIT_DEFAULT_TOOL_USE_AGENTS.has(
    agentName(agent.trim()).toLowerCase(),
  );
}

export function implicitDefaultToolUseAgents<
  T extends { readonly name: string },
>(agents: readonly T[]): T[] {
  return agents.filter((agent) =>
    isImplicitDefaultToolUseAgentAllowed(agent.name),
  );
}

export function resolveImplicitToolUseAgentDefault(
  agent: string | undefined,
): string | undefined {
  const trimmed = agent?.trim();
  if (!trimmed || !isImplicitDefaultToolUseAgentAllowed(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function resolveDefaultToolUseAgent<T extends { readonly name: string }>(
  agents: readonly T[] | undefined,
): string {
  const candidates = agents ? implicitDefaultToolUseAgents(agents) : [];
  const builtIn = candidates.find(
    (candidate) => agentName(candidate.name) === BUILTIN_DEFAULT_CHAT_AGENT,
  );
  return builtIn?.name ?? candidates[0]?.name ?? BUILTIN_DEFAULT_CHAT_AGENT;
}
