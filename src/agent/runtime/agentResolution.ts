import {
  computeAgentOptionsData,
  findAgentByIdentifier,
  getAgent,
  getAgentsByCategory,
  getAgentsBySource,
  getVisibleAgents,
  loadAgents,
  refresh,
  toRemoteAgentProfileData,
  type AgentEntry,
  type ResolvedAgent,
} from '@agent/index';
import type {
  AgentPrompt,
  AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import {
  AGENT_SOURCE,
  AgentCategory,
  type AgentSource,
  type AgentCategory as AgentCategoryType,
} from '@shared/schemas/agent';
import { BUILTIN_TEAM_ROOT_AGENT_NAMES } from '@shared/constants/agents';
import type { RemoteAgent } from '@shared/schemas/profileViewMessages';

import { getAgentPath } from './AgentLaunchContext';
import { loadAgentDefinitionInspectionData } from './agentLoad';

export type RuntimeAgentOptionsData = Awaited<
  ReturnType<typeof computeAgentOptionsData>
>;
export type RuntimeAgentEntry = AgentEntry;
export type RuntimeAgentLoadOptions = Parameters<typeof loadAgents>[0];
export const RUNTIME_BUILTIN_TEAM_ROOT_AGENT_NAMES =
  BUILTIN_TEAM_ROOT_AGENT_NAMES;

export interface RuntimeAgentIdentifierResolution {
  readonly resolved: RuntimeAgentEntry[];
  readonly missing: string[];
}

export interface RuntimeAgentListRequest {
  readonly category: AgentCategoryType;
  readonly visibleOnly?: boolean;
}

export interface RuntimeAgentDefinitionInspection {
  readonly resolution: ResolvedAgent;
  readonly rawDefinition?: object;
  readonly inheritedAgentName?: string;
  readonly settings: AgentSetting;
  readonly prompts: AgentPrompt;
}

/**
 * Resolve an agent and inspect both its raw local definition and processed
 * settings/prompts. Remote agents have no local raw YAML definition, but still
 * return the processed settings/prompts from the remote loader.
 */
export async function inspectRuntimeAgentDefinition(
  agentIdentifier: string,
  runtimeHost: AgentRuntimeHost,
  lookupCategory: AgentCategoryType = AgentCategory.Workflow,
  source?: AgentSource | null,
): Promise<RuntimeAgentDefinitionInspection> {
  const resolution = await getAgentPath(
    agentIdentifier,
    runtimeHost,
    lookupCategory,
    source,
  );
  const data = await loadAgentDefinitionInspectionData(resolution);
  return { resolution, ...data };
}

/** Ensure the runtime agent catalog is loaded. */
export function loadRuntimeAgents(
  options?: RuntimeAgentLoadOptions,
): Promise<void> {
  return loadAgents(options);
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
): AgentEntry | undefined {
  return getAgent(agentIdentifier);
}

export function getRuntimeWorkflowAgent(
  agentIdentifier: string,
): AgentEntry | undefined {
  return getAgent(agentIdentifier, AgentCategory.Workflow);
}

export function getRuntimeToolUseAgent(
  agentIdentifier: string,
): AgentEntry | undefined {
  return getAgent(agentIdentifier, AgentCategory.ToolUse);
}

/**
 * Resolve a list of plain or source-qualified identifiers inside a candidate
 * set while preserving the registry identity law in one runtime boundary.
 */
export function resolveRuntimeAgentIdentifiers(
  agents: readonly RuntimeAgentEntry[],
  identifiers: readonly string[],
): RuntimeAgentIdentifierResolution {
  const resolved: RuntimeAgentEntry[] = [];
  const missing: string[] = [];
  for (const identifier of identifiers) {
    const entry = findAgentByIdentifier(agents, identifier);
    if (entry) {
      resolved.push(entry);
    } else {
      missing.push(identifier);
    }
  }
  return { resolved, missing };
}

export function listRuntimeAgents({
  category,
  visibleOnly = false,
}: RuntimeAgentListRequest): AgentEntry[] {
  return visibleOnly
    ? getVisibleAgents(category)
    : getAgentsByCategory(category);
}

export function listRuntimeRemoteAgentProfiles(): RemoteAgent[] {
  return getAgentsBySource(AGENT_SOURCE.REMOTE).map(toRemoteAgentProfileData);
}

export function runtimeToolUseAgentHasAnyTool(
  agentIdentifier: string,
  toolNames: ReadonlySet<string>,
): boolean {
  return (
    getRuntimeToolUseAgent(agentIdentifier)?.tools?.some((toolName) =>
      toolNames.has(toolName),
    ) ?? false
  );
}
