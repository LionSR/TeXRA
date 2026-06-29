import { agentName } from '@shared/schemas';
import { PREFERRED_TOOL_USE_AGENTS } from '@shared/constants/agents';

export const BUILTIN_DEFAULT_CHAT_AGENT = 'assistant';

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

// Priority for the implicit default: the built-in default first, then the shared
// preferred order with the built-in removed so it isn't re-checked (it already
// appears in PREFERRED_TOOL_USE_AGENTS). Built once at module load.
const DEFAULT_AGENT_PRIORITY: readonly string[] = [
  BUILTIN_DEFAULT_CHAT_AGENT,
  ...PREFERRED_TOOL_USE_AGENTS.filter(
    (name) => name !== BUILTIN_DEFAULT_CHAT_AGENT,
  ),
];

/**
 * Pick the implicit default tool-use agent from the visible roster, so the
 * default follows whatever single agent or team the user applied:
 *
 *  1. the built-in default ({@link BUILTIN_DEFAULT_CHAT_AGENT}) when visible —
 *     a fresh, full-catalog workspace starts on `assistant`;
 *  2. otherwise the highest-priority visible agent by
 *     {@link PREFERRED_TOOL_USE_AGENTS} order (team leads/orchestrators first),
 *     so a scoped discipline roster defaults to its lead rather than whatever
 *     sorts first in the registry's file order;
 *  3. otherwise the first visible candidate.
 *
 * The trailing {@link BUILTIN_DEFAULT_CHAT_AGENT} only applies when no candidate
 * is visible at all (an empty/undefined roster — e.g. every tool-use agent
 * disabled). That is a deliberate last resort: it keeps `texra chat` usable by
 * falling back to the universal assistant rather than refusing to start. The
 * returned name may then sit outside a scoped roster — `chatToolUseAgentUsageError`
 * only rejects a name missing from the registry, not one merely hidden.
 */
export function pickDefaultToolUseAgent<T extends { readonly name: string }>(
  agents: readonly T[] | undefined,
): string {
  const candidates = agents ? implicitDefaultToolUseAgents(agents) : [];
  const findByName = (name: string): T | undefined =>
    candidates.find((candidate) => agentName(candidate.name) === name);
  for (const name of DEFAULT_AGENT_PRIORITY) {
    const found = findByName(name);
    if (found) return found.name;
  }
  return candidates[0]?.name ?? BUILTIN_DEFAULT_CHAT_AGENT;
}
