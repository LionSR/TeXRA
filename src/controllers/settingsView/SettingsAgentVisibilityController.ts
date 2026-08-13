// Local imports - shared
import type { AgentCategory, AgentSource } from '@shared/schemas/agent';
import { agentKeyOf } from '@shared/schemas/agent';
import type { SettingsAgentCatalogState } from './SettingsAgentCatalogController';

export interface SettingsAgentVisibilityEntry {
  source: AgentSource;
  name: string;
}

/**
 * The visibility controller reads a strict subset of the catalog state port
 * (`getEnabledAgentKeys` / `setEnabledAgentKeys` / `getAgents`); the factory
 * feeds it the same object it builds for the catalog controller rather than a
 * hand re-wired copy. `getAgents` is re-declared with the narrower
 * `SettingsAgentVisibilityEntry` shape only because the controller consumes
 * `source` + `name` — the catalog entries satisfy it structurally.
 */
type SettingsAgentVisibilityState = Pick<
  SettingsAgentCatalogState,
  'getEnabledAgentKeys' | 'setEnabledAgentKeys'
> & {
  getAgents(category: AgentCategory): SettingsAgentVisibilityEntry[];
};

interface SettingsAgentVisibilityControllerDeps {
  state: SettingsAgentVisibilityState;
}

export class SettingsAgentVisibilityController {
  constructor(private readonly deps: SettingsAgentVisibilityControllerDeps) {}

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

    const current =
      this.deps.state.getEnabledAgentKeys(input.category) ??
      allAgents.map((entry) => agentKeyOf(entry));

    let updated: string[];
    if (input.enabled) {
      const currentSet = new Set(current);
      updated = [
        ...current,
        ...[...targetKeys].filter((key) => !currentSet.has(key)),
      ];
    } else {
      updated = current.filter((key) => !targetKeys.has(key));
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
