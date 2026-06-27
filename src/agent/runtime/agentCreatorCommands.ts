import {
  createAgentCreatorFlow,
  TOOL_GROUPS,
  type AgentCategory,
  type AgentCreatorUI,
  type CreatorConfig,
} from '@agent/implementations/flows/agentCreator/agentCreatorFlow';

export type RuntimeAgentCreatorCategory = AgentCategory;
export type RuntimeAgentCreatorConfig = CreatorConfig;
export type RuntimeAgentCreatorUI = AgentCreatorUI;

export interface RuntimeAgentCreatorToolGroupOption {
  readonly label: string;
  readonly description: string;
  readonly detail: string;
  readonly picked: boolean;
}

export interface RuntimeAgentCreatorToolGroups {
  readonly tools: string[];
  readonly groups: string[];
}

export interface RuntimeAgentCreatorRunRequest {
  readonly ui: RuntimeAgentCreatorUI;
  readonly config: RuntimeAgentCreatorConfig;
  readonly category: RuntimeAgentCreatorCategory;
}

/** Project tool groups into display-ready options for a described agent. */
export function getRuntimeAgentCreatorToolGroupOptions(
  description: string,
): RuntimeAgentCreatorToolGroupOption[] {
  const lower = description.toLowerCase();
  const suggested = new Set<string>(['File Operations']);
  for (const [name, group] of Object.entries(TOOL_GROUPS)) {
    if (group.keywords.some((keyword) => lower.includes(keyword))) {
      suggested.add(name);
    }
  }

  return Object.entries(TOOL_GROUPS).map(([label, group]) => ({
    label,
    description: group.description,
    detail: group.tools.join(', '),
    picked: suggested.has(label),
  }));
}

/** Resolve selected tool-group labels into the tools consumed by the flow. */
export function resolveRuntimeAgentCreatorToolGroups(
  selectedLabels: readonly string[],
): RuntimeAgentCreatorToolGroups {
  const tools: string[] = [];
  const groups: string[] = [];

  for (const label of selectedLabels) {
    const group = TOOL_GROUPS[label];
    if (!group) continue;
    tools.push(...group.tools);
    groups.push(label);
  }

  return { tools, groups };
}

/** Run the runtime-owned agent-creation flow with host-provided UI callbacks. */
export async function runRuntimeAgentCreator({
  ui,
  config,
  category,
}: RuntimeAgentCreatorRunRequest): Promise<void> {
  const flow = createAgentCreatorFlow(ui);
  await flow.run({ config, category });
}
