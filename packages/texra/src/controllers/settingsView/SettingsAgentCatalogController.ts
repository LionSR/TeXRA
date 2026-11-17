// Third-party imports
import { Effect } from 'effect';

// Local imports
import {
  agentKeyOf,
  agentMatchesIdentifier,
  type AgentSource,
} from '@texra-ai/harness/schemas';
import {
  agentToolNames,
  type AgentEntry,
  type WorkspaceAgentsController,
} from '@texra-ai/harness/host';
import { type AgentSelectionItem } from '@texra/shared/settingsView/settingsViewMessages';

interface SettingsAgentCatalogEntry extends Pick<AgentEntry, 'persona'> {
  name: string;
  source: AgentSource;
  description?: string;
  path?: string;
  basedOn?: string;
}

interface SettingsAgentCatalogControllerDeps {
  workspaceAgents: WorkspaceAgentsController<SettingsAgentCatalogEntry>;
  getAgents(): SettingsAgentCatalogEntry[];
  /** The source of the changed bundled agent a customized copy overrides. */
  newerBuiltInOf(entry: SettingsAgentCatalogEntry): AgentSource | undefined;
}

export class SettingsAgentCatalogController {
  private readonly deps: SettingsAgentCatalogControllerDeps;
  constructor(deps: SettingsAgentCatalogControllerDeps) {
    this.deps = deps;
  }

  readonly buildSelectionItems = Effect.fn(
    'SettingsAgentCatalogController.buildSelectionItems',
  )({ self: this }, function* () {
    const enabledKeys = yield* this.enabledKeys();
    return this.deps
      .getAgents()
      .map((entry) => this.toSelectionItem(entry, enabledKeys))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  });

  /**
   * Enable or disable every agent from one source, as one store step, so a
   * single toggle landing meanwhile is not lost. Nothing is written when the
   * list would not change.
   */
  setAllAgentsEnabled(input: { source: AgentSource; enabled: boolean }) {
    return this.deps.workspaceAgents.setAgentEnabled({
      source: input.source,
      name: this.deps
        .getAgents()
        .filter((entry) => entry.source === input.source)
        .map((entry) => entry.name),
      enabled: input.enabled,
    });
  }

  /** The enabled keys; an `all` agent list enables every visible agent, never a
   *  custom agent the user hid. */
  private readonly enabledKeys = Effect.fn(
    'SettingsAgentCatalogController.enabledKeys',
  )({ self: this }, function* () {
    return (
      (yield* this.deps.workspaceAgents.getEnabledAgentKeys()) ??
      (yield* this.deps.workspaceAgents.visible()).map(agentKeyOf)
    );
  });

  private toSelectionItem(
    entry: SettingsAgentCatalogEntry,
    enabledKeys: readonly string[],
  ): AgentSelectionItem {
    return {
      name: entry.name,
      source: entry.source,
      description: entry.description,
      filePath: entry.path || undefined,
      tools: [...agentToolNames(entry)],
      newerBuiltIn: this.deps.newerBuiltInOf(entry),
      // A stored list holds resolved `source:name` keys, but older workspaces
      // persisted bare names, which `agentMatchesIdentifier` still matches.
      enabled: enabledKeys.some((key) => agentMatchesIdentifier(entry, key)),
    };
  }
}
