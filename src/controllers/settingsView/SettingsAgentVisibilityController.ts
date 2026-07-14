// Local imports - shared
import type { AgentCategory, AgentSource } from '@shared/schemas/agent';
import { agentKeyOf } from '@shared/schemas/agent';

export interface SettingsAgentVisibilityEntry {
  source: AgentSource;
  name: string;
}

interface SettingsAgentVisibilityState {
  getEnabledAgentKeys(category: AgentCategory): string[] | undefined;
  setAgentEnabled(input: {
    category: AgentCategory;
    source: AgentSource;
    name: string;
    enabled: boolean;
  }): Promise<void>;
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
    await this.deps.state.setAgentEnabled(input);
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

    if (
      updated.length === current.length &&
      updated.every((key, index) => key === current[index])
    ) {
      return;
    }
    await this.deps.state.setEnabledAgentKeys(input.category, updated);
  }
}
