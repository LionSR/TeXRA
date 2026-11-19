import { agentName } from '@texra-ai/harness/schemas';

/** Bundled agent that runs the agent-led setup conversation. */
export const SETUP_AGENT_NAME = 'setup';

/**
 * The agents a new conversation starts on when the person has chosen none,
 * best first: it starts on the first of them the person can see. Every agent
 * list (the window launcher's menu, the terminal's `/agent`) shows them first
 * in this order, so the first row is the agent a bare Enter starts. After the
 * built-in default come the orchestrators, so a narrowed agent list defaults
 * to a lead, then general and task-flavored fallbacks.
 */
const DEFAULT_AGENT_ORDER = Object.freeze([
  'assistant',
  'orchestrator',
  'leanOrchestrator',
  'engineer',
  'research',
  'review',
] as const);

// Agents that exist in the catalog but must never be auto-selected as the
// implicit chat default — e.g. `simplifier` is a code utility, not a chat
// partner. They remain available when chosen explicitly with `--agent`.
const NON_DEFAULT_TOOL_USE_AGENTS = new Set(['simplifier']);

/** Whether `agent` may be chosen as the implicit default agent. */
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

/** An agent's place in an agent list: the default order first, then the
 *  rest, then the agents never started on implicitly. */
function defaultRank(agent: string): number {
  if (!isImplicitDefaultEligible(agent)) return DEFAULT_AGENT_ORDER.length + 1;
  const name = agentName(agent);
  const rank = DEFAULT_AGENT_ORDER.findIndex((entry) => entry === name);
  return rank < 0 ? DEFAULT_AGENT_ORDER.length : rank;
}

/**
 * The order every agent list shows agents in, by name: by
 * {@link DEFAULT_AGENT_ORDER}, then alphabetically, with the agents never
 * started on implicitly last. The first of a list sorted by it is the agent
 * {@link pickDefaultToolUseAgent} picks from that list.
 */
export function compareAgentsForDefault(a: string, b: string): number {
  return defaultRank(a) - defaultRank(b) || a.localeCompare(b);
}

/**
 * The agent a new conversation starts on when the person has chosen none,
 * from the agents they can see: the first of them in
 * {@link compareAgentsForDefault} order, so the default follows the agents
 * the user chose to show.
 *
 * When none of them may be started on implicitly (an empty list, or every
 * visible agent excluded), the first of {@link DEFAULT_AGENT_ORDER} is the
 * last resort: it keeps a chat usable rather than refusing to start. The
 * returned name may then sit outside a scoped agent list; a launch resolves
 * it through the catalog and rejects only a name the catalog does not know
 * or hides.
 */
export function pickDefaultToolUseAgent<T extends { readonly name: string }>(
  agents: readonly T[] | undefined,
): string {
  const first = agents
    ?.toSorted((a, b) => compareAgentsForDefault(a.name, b.name))
    .at(0);
  return first !== undefined && isImplicitDefaultEligible(first.name)
    ? first.name
    : DEFAULT_AGENT_ORDER[0];
}
