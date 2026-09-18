/**
 * Constructs the settings-view agent controllers (catalog / directory /
 * roster) from the host-supplied state ports.
 *
 * Both desktop and extension build these controllers with the same shape;
 * this factory removes ~75 lines of duplication on each side.
 */
import {
  AgentRosterController,
  createWorkspaceAgentRosterController,
  getAgent,
  getAgentsByCategory,
  getVisibleAgents as getVisibleRegistryAgents,
  type AgentEntry,
} from '@agent/index';
import { SettingsAgentDirectoryController } from '@controllers/settingsView/SettingsAgentDirectoryController';
import {
  SettingsAgentCatalogController,
  type SettingsAgentCatalogState,
} from '@controllers/settingsView/SettingsAgentCatalogController';
import {
  agentKey,
  type AgentCategory,
  type AgentSource,
} from '@shared/schemas';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';

import type { AgentDirectoriesFailed } from '@platform/interfaces';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import type { Effect } from 'effect';

interface AgentControllerFactoryOptions extends SettingsStatePorts {
  /** The host's agent directories as `AgentDirectoriesPort` declares them:
   *  Effects, so a directory that cannot be resolved reaches the caller that
   *  asked for it instead of an untyped rejection. */
  readonly getCustomAgentDirectory: () => Effect.Effect<
    string,
    AgentDirectoriesFailed
  >;
  readonly getSourceDirectory: (
    source: AgentSource,
  ) => Effect.Effect<string | undefined, AgentDirectoriesFailed>;
  readonly getAgents?: (category: AgentCategory) => AgentEntry[];
  readonly getVisibleAgents?: (category: AgentCategory) => AgentEntry[];
}

export interface SettingsAgentControllers {
  readonly catalog: SettingsAgentCatalogController;
  readonly directory: SettingsAgentDirectoryController;
  readonly roster: AgentRosterController;
}

export function createSettingsAgentControllers(
  options: AgentControllerFactoryOptions,
): SettingsAgentControllers {
  const { workspaceState, globalState } = options;
  const getAgents = options.getAgents ?? getAgentsByCategory;
  const getVisibleAgents = options.getVisibleAgents ?? getVisibleRegistryAgents;
  const roster = createWorkspaceAgentRosterController(
    { workspaceState, globalState },
    getAgents,
  );

  const state: SettingsAgentCatalogState = {
    getEnabledAgentKeys: (category) => roster.getEnabledAgentKeys(category),
    setEnabledAgentKeys: (category, enabledKeys) =>
      roster.setEnabledAgentKeys(category, enabledKeys),
    setTeamRoster: (preset) => roster.setTeam(preset.id),
    getAgents,
    getVisibleAgents,
    getCustomPresetsRaw: () =>
      workspaceState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, []),
    setCustomPresets: (presets) =>
      workspaceState.update(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, presets),
    removeCustomPreset: (presetId, remaining) =>
      roster.removeTeamPreset(presetId, () =>
        workspaceState.update(
          WorkspaceStateKey.CUSTOM_AGENT_PRESETS,
          remaining,
        ),
      ),
  };

  const catalog = new SettingsAgentCatalogController({
    state,
  });
  const directory = new SettingsAgentDirectoryController({
    state: {
      getConfiguredCustomDir: () =>
        globalState.get<string>(GlobalStateKey.CUSTOM_AGENT_DIR, ''),
      setConfiguredCustomDir: (customDir) =>
        globalState.update(
          GlobalStateKey.CUSTOM_AGENT_DIR,
          customDir || undefined,
        ),
      getCustomDir: options.getCustomAgentDirectory,
      getSourceDir: options.getSourceDirectory,
      getAgent: (source, name) => getAgent(agentKey(source, name)) ?? null,
    },
  });

  return { catalog, directory, roster };
}
