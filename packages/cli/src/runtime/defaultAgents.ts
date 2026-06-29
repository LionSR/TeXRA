import { agentName } from '@shared/schemas';
import { PREFERRED_TOOL_USE_AGENTS } from '@shared/constants/agents';

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

/**
 * Implicit default tool-use agent for the CLI, resolved against the visible
 * roster so it follows whatever single agent or team the user applied:
 *
 *  1. the built-in default ({@link BUILTIN_DEFAULT_CHAT_AGENT}) when visible —
 *     i.e. a fresh, full-catalog workspace starts on `assistant`;
 *  2. otherwise the highest-priority visible agent by
 *     {@link PREFERRED_TOOL_USE_AGENTS} order (team leads/orchestrators first),
 *     so a scoped discipline roster defaults to its lead rather than whichever
 *     agent happens to sort first in the registry's file order;
 *  3. otherwise any visible candidate.
 *
 * The trailing `BUILTIN_DEFAULT_CHAT_AGENT` fallback only applies when no
 * visible candidates were supplied (empty/undefined) — a degenerate case where
 * the returned name may not be in the visible set. That is deliberate and safe:
 * chat launch re-validates via `chatToolUseAgentUsageError`, so an unavailable
 * default surfaces a usage error instead of launching silently.
 */
export function resolveDefaultToolUseAgent<T extends { readonly name: string }>(
  agents: readonly T[] | undefined,
): string {
  const candidates = agents ? implicitDefaultToolUseAgents(agents) : [];
  const findByName = (name: string): T | undefined =>
    candidates.find((candidate) => agentName(candidate.name) === name);
  for (const name of [
    BUILTIN_DEFAULT_CHAT_AGENT,
    ...PREFERRED_TOOL_USE_AGENTS,
  ]) {
    const found = findByName(name);
    if (found) return found.name;
  }
  return candidates[0]?.name ?? BUILTIN_DEFAULT_CHAT_AGENT;
}
