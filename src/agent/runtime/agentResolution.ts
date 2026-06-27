import {
  computeAgentOptionsData,
  findAgentByIdentifier,
  getAgent,
  getAgentsByCategory,
  getVisibleAgents,
  loadAgents,
  refresh,
  type AgentEntry,
  type ResolvedAgent,
} from '@agent/index';
import {
  AgentCategory,
  type AgentSource,
  type AgentCategory as AgentCategoryType,
} from '@shared/schemas/agent';
import { BUILTIN_TEAM_ROOT_AGENT_NAMES } from '@shared/constants/agents';

import { getAgentPath } from './AgentLaunchContext';
import type { AgentRuntimeHost } from './AgentRuntimeHost';

export type RuntimeAgentOptionsData = Awaited<
  ReturnType<typeof computeAgentOptionsData>
>;
export type RuntimeAgentEntry = AgentEntry;
export type RuntimeAgentLoadOptions = Parameters<typeof loadAgents>[0];
export const RUNTIME_BUILTIN_TEAM_ROOT_AGENT_NAMES =
  BUILTIN_TEAM_ROOT_AGENT_NAMES;

/** Resolve an agent identifier for host commands without exposing launch context. */
export async function resolveRuntimeAgentPath(
  agentIdentifier: string,
  runtimeHost: AgentRuntimeHost,
  lookupCategory: AgentCategoryType = AgentCategory.Workflow,
  source?: AgentSource | null,
): Promise<ResolvedAgent> {
  return getAgentPath(agentIdentifier, runtimeHost, lookupCategory, source);
}

/** Ensure the runtime agent catalog is loaded. */
export function loadRuntimeAgents(
  options?: RuntimeAgentLoadOptions,
): Promise<void> {
  return options === undefined ? loadAgents() : loadAgents(options);
}

/** Return display-ready agent catalog options for UI pickers. */
export function computeRuntimeAgentOptionsData(): Promise<RuntimeAgentOptionsData> {
  return computeAgentOptionsData();
}

/** Refresh the runtime agent catalog after sources or visibility change. */
export function refreshRuntimeAgentCatalog(): Promise<void> {
  return refresh();
}

export function getRuntimeAgent(
  agentIdentifier: string,
  lookupCategory?: AgentCategoryType,
): AgentEntry | undefined {
  return lookupCategory === undefined
    ? getAgent(agentIdentifier)
    : getAgent(agentIdentifier, lookupCategory);
}

export function getRuntimeAgentByIdentifier(
  agentIdentifier: string,
): AgentEntry | undefined {
  return getAgent(agentIdentifier);
}

export function findRuntimeAgentByIdentifier(
  agents: readonly AgentEntry[],
  agentIdentifier: string,
): AgentEntry | undefined {
  return findAgentByIdentifier(agents, agentIdentifier);
}

export function listRuntimeAgentsByCategory(
  category: AgentCategoryType,
): AgentEntry[] {
  return getAgentsByCategory(category);
}

export function listRuntimeVisibleAgents(
  category: AgentCategoryType,
): AgentEntry[] {
  return getVisibleAgents(category);
}

export function getRuntimeToolUseAgentCategory(
  agentIdentifier: string,
): AgentCategoryType | undefined {
  return getRuntimeAgent(agentIdentifier, AgentCategory.ToolUse)?.category;
}

export function runtimeToolUseAgentHasAnyTool(
  agentIdentifier: string,
  toolNames: ReadonlySet<string>,
): boolean {
  return (
    getRuntimeAgent(agentIdentifier, AgentCategory.ToolUse)?.tools?.some(
      (toolName) => toolNames.has(toolName),
    ) ?? false
  );
}
