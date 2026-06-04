import { agentName } from '@shared/schemas';

export const BUILTIN_DEFAULT_CHAT_AGENT = 'chat';

const NON_IMPLICIT_DEFAULT_TOOL_USE_AGENTS = new Set(['simplifier']);

export function isImplicitDefaultToolUseAgentAllowed(agent: string): boolean {
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
