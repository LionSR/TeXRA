/**
 * Constructs the settings-view agent controllers (catalog / directory /
 * visibility / custom-agent file planner / remote-prompt viewer) from the
 * host-supplied state ports.
 *
 * Both desktop and extension build these controllers with the same shape;
 * this factory removes ~75 lines of duplication on each side.
 */
import {
  AgentRosterController,
  BUILTIN_TEAM_ROOT_AGENT_NAMES,
  getAgent,
  getAgentsByCategory,
  getRosterAgent,
  getVisibleAgents as getVisibleRegistryAgents,
  type AgentEntry,
} from '@agent/index';
import { fetchRemoteAgentConfigYaml } from '@agent/remote/remoteAgentConfigClient';
import { SupabaseClient } from '@auth/SupabaseClient';
import { SettingsAgentVisibilityController } from '@controllers/settingsView/SettingsAgentVisibilityController';
import { SettingsAgentDirectoryController } from '@controllers/settingsView/SettingsAgentDirectoryController';
import {
  SettingsAgentCatalogController,
  type SettingsAgentCatalogState,
} from '@controllers/settingsView/SettingsAgentCatalogController';
import { SettingsAgentFileController } from '@controllers/settingsView/SettingsAgentFileController';
import { SettingsRemoteAgentPromptController } from '@controllers/settingsView/SettingsRemoteAgentPromptController';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  agentKey,
  type AgentCategory,
  type AgentSource,
} from '@shared/schemas/agent';
import { parseAgentModePresets } from '@shared/schemas/agentPresets';

import type { SettingsStatePorts } from '@shared/settingsView/types';

export interface AgentControllerFactoryOptions extends SettingsStatePorts {
  readonly getCustomAgentDirectory: () => Promise<string>;
  readonly getSourceDirectory: (
    source: AgentSource,
  ) => Promise<string | undefined>;
  readonly getAgents?: (category: AgentCategory) => AgentEntry[];
  readonly getVisibleAgents?: (category: AgentCategory) => AgentEntry[];
  readonly builtInOrchestratorAgentNames?: readonly string[];
}

export interface SettingsAgentControllers {
  readonly catalog: SettingsAgentCatalogController;
  readonly directory: SettingsAgentDirectoryController;
  readonly visibility: SettingsAgentVisibilityController;
  readonly roster: AgentRosterController;
  readonly fileController: SettingsAgentFileController;
  readonly remotePromptController: SettingsRemoteAgentPromptController;
}

export function createSettingsAgentControllers(
  options: AgentControllerFactoryOptions,
): SettingsAgentControllers {
  const { workspaceState, globalState } = options;
  const getAgents = options.getAgents ?? getAgentsByCategory;
  const getVisibleAgents = options.getVisibleAgents ?? getVisibleRegistryAgents;
  const roster = new AgentRosterController({
    workspaceState,
    globalState,
    getAgents,
    getPresets: () =>
      parseAgentModePresets(
        workspaceState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, []),
      ),
    resolveAgent: getRosterAgent,
    fallbackTeamId: null,
  });

  const state: SettingsAgentCatalogState = {
    getEnabledAgentKeys: (category) => roster.getEnabledAgentKeys(category),
    setEnabledAgentKeys: (category, enabledKeys) =>
      roster.setEnabledAgentKeys(category, enabledKeys),
    setTeamRoster: (preset) => roster.setTeam(preset.id),
    getAgents,
    getVisibleAgents,
    getCustomPresetsRaw: () =>
      workspaceState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, []),
    setCustomPresets: async (presets) => {
      await workspaceState.update(
        WorkspaceStateKey.CUSTOM_AGENT_PRESETS,
        presets,
      );
    },
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
    builtInOrchestratorAgentNames:
      options.builtInOrchestratorAgentNames ?? BUILTIN_TEAM_ROOT_AGENT_NAMES,
  });
  const directory = new SettingsAgentDirectoryController({
    state: {
      getConfiguredCustomDir: () =>
        globalState.get<string>(GlobalStateKey.CUSTOM_AGENT_DIR, ''),
      setConfiguredCustomDir: async (customDir) => {
        await globalState.update(
          GlobalStateKey.CUSTOM_AGENT_DIR,
          customDir || undefined,
        );
      },
      getCustomDir: options.getCustomAgentDirectory,
      getSourceDir: options.getSourceDirectory,
      getAgent: (source, name) => getAgent(agentKey(source, name)) ?? null,
    },
  });
  const visibility = new SettingsAgentVisibilityController({
    state,
  });
  const fileController = new SettingsAgentFileController();
  const remotePromptController = new SettingsRemoteAgentPromptController({
    getUserTier: () => SupabaseClient.getUserTier(),
    getAccessToken: () => SupabaseClient.getAccessToken(),
    fetchPromptConfig: fetchRemoteAgentConfigYaml,
  });

  return {
    catalog,
    directory,
    visibility,
    roster,
    fileController,
    remotePromptController,
  };
}
