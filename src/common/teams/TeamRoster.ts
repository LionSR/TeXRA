import {
  agentKeyOf,
  type AgentCategory,
  type AgentSource,
} from '@shared/schemas/agent';
import type { AgentModePreset } from '@shared/schemas/agentPresets';

export interface TeamRosterState {
  getAgents(category: AgentCategory): { name: string; source: AgentSource }[];
  setEnabledAgentKeys(
    category: AgentCategory,
    enabledKeys: string[],
  ): Promise<void>;
}

export interface TeamRosterResolution {
  readonly workflowKeys: string[];
  readonly toolUseKeys: string[];
  readonly unresolvedNames: string[];
}

export interface TeamRosterCatalog {
  resolvePreset(presetId: string):
    | {
        readonly ok: true;
        readonly preset: AgentModePreset;
        readonly resolution: TeamRosterResolution;
      }
    | { readonly ok: false; readonly reason: 'unknownPreset' };
  commitPresetResolution(
    preset: AgentModePreset,
    resolution: TeamRosterResolution,
  ): Promise<void>;
}

/** Resolve a team against the current catalog without writing roster state. */
export function resolveTeamRoster(
  state: Pick<TeamRosterState, 'getAgents'>,
  preset: AgentModePreset,
): TeamRosterResolution {
  const workflow = resolveAgentKeys(state, 'workflow', preset.workflowAgents);
  const toolUse = resolveAgentKeys(state, 'toolUse', preset.toolUseAgents);
  return {
    workflowKeys: workflow.keys,
    toolUseKeys: toolUse.keys,
    unresolvedNames: [...workflow.unresolved, ...toolUse.unresolved],
  };
}

/** Commit a previously resolved roster. */
export async function commitTeamRoster(
  state: Pick<TeamRosterState, 'setEnabledAgentKeys'>,
  resolution: TeamRosterResolution,
): Promise<void> {
  await state.setEnabledAgentKeys('workflow', resolution.workflowKeys);
  await state.setEnabledAgentKeys('toolUse', resolution.toolUseKeys);
}

/**
 * Legacy presets without provenance conservatively preflight every unresolved
 * member. Known local members already resolve and therefore never enter this
 * set; explicit metadata remains authoritative for current presets.
 */
export function teamHostedNamesForPreflight(
  preset: AgentModePreset,
  unresolvedNames: readonly string[],
): ReadonlySet<string> {
  return new Set(preset.texraHostedAgents ?? unresolvedNames);
}

function resolveAgentKeys(
  state: Pick<TeamRosterState, 'getAgents'>,
  category: AgentCategory,
  names: string[],
): { keys: string[]; unresolved: string[] } {
  const entries = state.getAgents(category);
  const unresolved: string[] = [];
  const keys = names.map((name) => {
    const entry = entries.find((candidate) => candidate.name === name);
    if (entry) return agentKeyOf(entry);
    unresolved.push(name);
    return name;
  });
  return { keys, unresolved };
}
