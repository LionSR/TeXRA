// Local imports - shared
import type { AgentCategory, AgentSource } from '@shared/schemas/agent';
import { agentKeyOf } from '@shared/schemas/agent';

// Local imports - controllers
import { enabledKeysIncludeAgent } from './SettingsAgentCatalogController';

export interface SettingsAgentVisibilityEntry {
  source: AgentSource;
  name: string;
}

interface SettingsAgentVisibilityState {
  getEnabledAgentKeys(category: AgentCategory): string[] | undefined;
  setEnabledAgentKeys(
    category: AgentCategory,
    enabledKeys: string[],
  ): Promise<void>;
  getAgents(category: AgentCategory): SettingsAgentVisibilityEntry[];
}

export interface SettingsAgentVisibilityControllerDeps {
  state: SettingsAgentVisibilityState;
}

export class SettingsAgentVisibilityController {
  constructor(private readonly deps: SettingsAgentVisibilityControllerDeps) {}

  async setAgentEnabled(input: {
    category: AgentCategory;
    source: AgentSource;
    name: string;
    enabled: boolean;
  }): Promise<void> {
    const raw = this.deps.state.getEnabledAgentKeys(input.category);
    const current = raw ?? [];
    const key = agentKeyOf(input);

    let updated: string[];
    if (input.enabled) {
      updated = enabledKeysIncludeAgent(current, input)
        ? current
        : [...current, key];
    } else if (raw === undefined) {
      updated = this.deps.state
        .getAgents(input.category)
        .map((entry) => agentKeyOf(entry))
        .filter((candidate) => candidate !== key);
    } else {
      updated = current.filter(
        (entry) => entry !== key && entry !== input.name,
      );
    }

    await this.deps.state.setEnabledAgentKeys(input.category, updated);
  }

  async setAllAgentsEnabled(input: {
    category: AgentCategory;
    source: AgentSource;
    enabled: boolean;
  }): Promise<void> {
    const allAgents = this.deps.state.getAgents(input.category);
    const sourceAgents = allAgents.filter(
      (entry) => entry.source === input.source,
    );
    const targetKeys = new Set(sourceAgents.map((entry) => agentKeyOf(entry)));
    const targetLegacyNames = new Set(sourceAgents.map((entry) => entry.name));

    const raw = this.deps.state.getEnabledAgentKeys(input.category);
    const current = raw ?? allAgents.map((entry) => agentKeyOf(entry));

    let updated: string[];
    if (input.enabled) {
      const currentSet = new Set(current);
      updated = [
        ...current,
        ...[...targetKeys].filter((key) => !currentSet.has(key)),
      ];
    } else {
      updated = current.filter(
        (key) => !targetKeys.has(key) && !targetLegacyNames.has(key),
      );
    }

    await this.deps.state.setEnabledAgentKeys(input.category, updated);
  }
}
