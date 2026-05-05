// Local imports - shared
import type { AgentModePreset } from '@shared/schemas/agentPresets';
import {
  AGENT_MODE_PRESETS,
  AgentModePresetSchema,
} from '@shared/schemas/agentPresets';
import {
  agentKey,
  type AgentCategory,
  type AgentSource,
} from '@shared/schemas/agent';
import type { AgentSelectionItem } from '@shared/schemas/settingsViewMessages';

export interface SettingsAgentCatalogEntry {
  name: string;
  source: AgentSource;
  category: AgentCategory;
  description?: string;
  path?: string;
  multiplePath?: string;
  isMultiple?: boolean;
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
  now?: () => number;
}

export type SettingsAgentPresetApplyResult =
  | { ok: true; preset: AgentModePreset }
  | { ok: false; reason: 'unknownPreset' };

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
    return AgentModePresetSchema.array()
      .catch([])
      .parse(this.deps.state.getCustomPresetsRaw());
  }

  getCustomPreset(presetId: string): AgentModePreset | null {
    return (
      this.getCustomPresets().find((preset) => preset.id === presetId) ?? null
    );
  }

  async applyPreset(presetId: string): Promise<SettingsAgentPresetApplyResult> {
    const preset = this.getPreset(presetId);
    if (!preset) return { ok: false, reason: 'unknownPreset' };

    await this.deps.state.setEnabledAgentKeys(
      'workflow',
      this.resolveAgentKeys('workflow', new Set(preset.workflowAgents)),
    );
    await this.deps.state.setEnabledAgentKeys(
      'toolUse',
      this.resolveAgentKeys('toolUse', new Set(preset.toolUseAgents)),
    );

    return { ok: true, preset };
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
      icon: 'codicon-bookmark',
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
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private toSelectionItem(
    entry: SettingsAgentCatalogEntry,
    enabledKeys: string[] | undefined,
  ): AgentSelectionItem {
    const key = agentKey(entry.source, entry.name);
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
        enabledKeys.includes(key) ||
        enabledKeys.includes(entry.name),
    };
  }

  private getPreset(presetId: string): AgentModePreset | null {
    return (
      AGENT_MODE_PRESETS.find((preset) => preset.id === presetId) ??
      this.getCustomPreset(presetId)
    );
  }

  private resolveAgentKeys(
    category: AgentCategory,
    names: Set<string>,
  ): string[] {
    return this.deps.state
      .getAgents(category)
      .filter((entry) => names.has(entry.name))
      .map((entry) => agentKey(entry.source, entry.name));
  }
}
