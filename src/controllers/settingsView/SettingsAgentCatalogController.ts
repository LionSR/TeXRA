// Local imports - shared
import type { AgentModePreset } from '@shared/schemas/agentPresets';
import {
  AGENT_MODE_PRESETS_BY_ID,
  parseAgentModePresets,
} from '@shared/schemas/agentPresets';
import {
  agentKeyOf,
  type AgentCategory,
  type AgentSource,
} from '@shared/schemas/agent';
import type { AgentSelectionItem } from '@shared/schemas/settingsViewMessages';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { byName } from '@utils/core';

export interface SettingsAgentCatalogEntry {
  name: string;
  source: AgentSource;
  category: AgentCategory;
  description?: string;
  path?: string;
  tools?: string[];
}

export interface SettingsAgentCatalogState {
  getEnabledAgentKeys(category: AgentCategory): string[] | undefined;
  setEnabledAgentKeys(
    category: AgentCategory,
    enabledKeys: string[],
  ): Promise<void>;
  getAgents(category: AgentCategory): SettingsAgentCatalogEntry[];
  getVisibleAgents(category: AgentCategory): SettingsAgentCatalogEntry[];
  getCustomPresetsRaw(): unknown;
  setCustomPresets(presets: AgentModePreset[]): Promise<void>;
}

export interface SettingsAgentCatalogControllerDeps {
  state: SettingsAgentCatalogState;
  builtInOrchestratorAgentNames?: readonly string[];
  now?: () => number;
}

export type SettingsAgentPresetApplyResult =
  | {
      ok: true;
      preset: AgentModePreset;
      unresolvedNames: string[];
    }
  | { ok: false; reason: 'unknownPreset' };

/**
 * True when a persisted enabled-keys list marks this agent enabled. The list
 * stores each agent as its resolved `source:name` key, but older workspaces
 * persisted bare agent names — match either so a legacy roster keeps working.
 */
export function enabledKeysIncludeAgent(
  enabledKeys: readonly string[],
  entry: { source: AgentSource; name: string },
): boolean {
  return (
    enabledKeys.includes(agentKeyOf(entry)) || enabledKeys.includes(entry.name)
  );
}

/**
 * Minimal catalog surface needed to apply a preset roster. Structurally a
 * subset of {@link SettingsAgentCatalogState}, so the controller's state port
 * satisfies it directly.
 */
export interface PresetRosterState {
  getAgents(category: AgentCategory): { name: string; source: AgentSource }[];
  setEnabledAgentKeys(
    category: AgentCategory,
    enabledKeys: string[],
  ): Promise<void>;
}

/**
 * Resolve a preset's agent names against the live catalog and write both
 * workspace roster keys. Single application path shared by the Settings
 * "apply team" action, the setup agent's `apply_team` tool, and default-team
 * seeding of fresh workspaces — so the paths can't drift.
 *
 * Resolved names are written as `source:name` keys. Names that don't resolve
 * right now (relay-served orchestrators while signed out, agents not yet
 * installed) are kept as bare names: visibility filtering matches by name, so
 * the agent joins the roster the moment it appears (e.g. after sign-in)
 * instead of being silently dropped. Returns the written keys per category
 * plus the names that didn't resolve.
 */
export async function applyPresetRoster(
  state: PresetRosterState,
  preset: AgentModePreset,
): Promise<{
  workflowKeys: string[];
  toolUseKeys: string[];
  unresolvedNames: string[];
}> {
  const workflow = resolvePresetAgentKeys(
    state,
    'workflow',
    preset.workflowAgents,
  );
  const toolUse = resolvePresetAgentKeys(
    state,
    'toolUse',
    preset.toolUseAgents,
  );
  await state.setEnabledAgentKeys('workflow', workflow.keys);
  await state.setEnabledAgentKeys('toolUse', toolUse.keys);
  return {
    workflowKeys: workflow.keys,
    toolUseKeys: toolUse.keys,
    unresolvedNames: [...workflow.unresolved, ...toolUse.unresolved],
  };
}

function resolvePresetAgentKeys(
  state: PresetRosterState,
  category: AgentCategory,
  names: string[],
): { keys: string[]; unresolved: string[] } {
  const entries = state.getAgents(category);
  const unresolved: string[] = [];
  const keys = names.map((name) => {
    const entry = entries.find((candidate) => candidate.name === name);
    if (entry) return agentKeyOf(entry);
    unresolved.push(name);
    // Keep unresolved names so relay-only team members survive until sign-in
    // loads the source that can resolve them.
    return name;
  });
  return { keys, unresolved };
}

export class SettingsAgentCatalogController {
  constructor(private readonly deps: SettingsAgentCatalogControllerDeps) {}

  buildSelectionItems(): {
    workflow: AgentSelectionItem[];
    toolUse: AgentSelectionItem[];
  } {
    return {
      workflow: this.buildCategorySelectionItems('workflow'),
      toolUse: this.buildCategorySelectionItems('toolUse'),
    };
  }

  getCustomPresets(): AgentModePreset[] {
    return parseAgentModePresets(this.deps.state.getCustomPresetsRaw());
  }

  getCustomPreset(presetId: string): AgentModePreset | null {
    return (
      this.getCustomPresets().find((preset) => preset.id === presetId) ?? null
    );
  }

  getOrchestratorAgentNames(): string[] {
    const names = new Set(this.deps.builtInOrchestratorAgentNames ?? []);
    for (const agent of this.deps.state.getAgents('toolUse')) {
      if (hasDelegationTool(agent.tools)) names.add(agent.name);
    }
    return [...names].sort();
  }

  getPresetToolUseRoot(toolUseAgents: string[]): string | undefined {
    const orchestratorNames = new Set(this.getOrchestratorAgentNames());
    return toolUseAgents.find(
      (name) => orchestratorNames.has(name) || isOrchestratorLikeName(name),
    );
  }

  async applyPreset(presetId: string): Promise<SettingsAgentPresetApplyResult> {
    const preset = this.getPreset(presetId);
    if (!preset) return { ok: false, reason: 'unknownPreset' };

    const { unresolvedNames } = await applyPresetRoster(
      this.deps.state,
      preset,
    );

    return { ok: true, preset, unresolvedNames };
  }

  async saveCurrentPreset(name: string): Promise<AgentModePreset> {
    const trimmedName = name.trim();
    const workflowAgents = this.deps.state
      .getVisibleAgents('workflow')
      .map((entry) => entry.name);
    const toolUseAgents = this.deps.state
      .getVisibleAgents('toolUse')
      .map((entry) => entry.name);
    const preset: AgentModePreset = {
      id: `custom-${this.deps.now?.() ?? Date.now()}`,
      name: trimmedName,
      description: `Custom team: ${[...toolUseAgents, ...workflowAgents].join(', ')}`,
      icon: 'bookmark',
      workflowAgents,
      toolUseAgents,
    };

    await this.deps.state.setCustomPresets([
      ...this.getCustomPresets(),
      preset,
    ]);
    return preset;
  }

  async deleteCustomPreset(presetId: string): Promise<AgentModePreset | null> {
    const presets = this.getCustomPresets();
    const target = presets.find((preset) => preset.id === presetId);
    if (!target) return null;

    await this.deps.state.setCustomPresets(
      presets.filter((preset) => preset.id !== presetId),
    );
    return target;
  }

  private buildCategorySelectionItems(
    category: AgentCategory,
  ): AgentSelectionItem[] {
    const enabledKeys = this.deps.state.getEnabledAgentKeys(category);
    return this.deps.state
      .getAgents(category)
      .map((entry) => this.toSelectionItem(entry, enabledKeys))
      .sort(byName);
  }

  private toSelectionItem(
    entry: SettingsAgentCatalogEntry,
    enabledKeys: string[] | undefined,
  ): AgentSelectionItem {
    return {
      name: entry.name,
      source: entry.source,
      category: entry.category,
      description: entry.description,
      hasPath: Boolean(entry.path),
      filePath: entry.path || undefined,
      tools: entry.tools,
      // undefined = never configured -> all enabled; [] = explicitly none enabled.
      enabled:
        enabledKeys === undefined ||
        enabledKeysIncludeAgent(enabledKeys, entry),
    };
  }

  private getPreset(presetId: string): AgentModePreset | null {
    return (
      AGENT_MODE_PRESETS_BY_ID.get(presetId) ?? this.getCustomPreset(presetId)
    );
  }
}

function isOrchestratorLikeName(name: string): boolean {
  return name.toLowerCase().endsWith('orchestrator');
}
