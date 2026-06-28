/**
 * Constructs the trio of settings-view agent controllers
 * (catalog / directory / visibility) from the host-supplied state ports.
 *
 * Both desktop and extension build these controllers with the same shape;
 * this factory removes ~75 lines of duplication on each side.
 */
import {
  SettingsAgentCatalogController,
  type SettingsAgentCatalogState,
} from '@controllers/settingsView/SettingsAgentCatalogController';
import { SettingsAgentDirectoryController } from '@controllers/settingsView/SettingsAgentDirectoryController';
import { SettingsAgentVisibilityController } from '@controllers/settingsView/SettingsAgentVisibilityController';
import {
  getRuntimeAgent,
  listRuntimeAgents,
  loadRuntimeAgents,
  RUNTIME_BUILTIN_TEAM_ROOT_AGENT_NAMES,
  type RuntimeAgentEntry,
} from '@agent/runtime/agentResolution';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import type { AgentCategory, AgentSource } from '@shared/schemas/agent';

import type { SettingsStatePorts } from '@shared/settingsView/types';

export interface AgentControllerFactoryOptions extends SettingsStatePorts {
  readonly getCustomAgentDirectory: () => Promise<string>;
  readonly getSourceDirectory: (
    source: AgentSource,
  ) => Promise<string | undefined>;
  readonly getAgents?: (category: AgentCategory) => RuntimeAgentEntry[];
  readonly getVisibleAgents?: (category: AgentCategory) => RuntimeAgentEntry[];
  readonly loadAgents?: () => Promise<void>;
  readonly builtInOrchestratorAgentNames?: readonly string[];
}

export interface SettingsAgentControllers {
  readonly catalog: SettingsAgentCatalogController;
  readonly directory: SettingsAgentDirectoryController;
  readonly visibility: SettingsAgentVisibilityController;
  readonly state: SettingsAgentCatalogState;
}

function agentStateKey(category: AgentCategory): WorkspaceStateKey {
  return category === 'workflow'
    ? WorkspaceStateKey.ENABLED_AGENTS
    : WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS;
}

export function createSettingsAgentControllers(
  options: AgentControllerFactoryOptions,
): SettingsAgentControllers {
  const { workspaceState, globalState } = options;
  const getAgents =
    options.getAgents ?? ((category) => listRuntimeAgents({ category }));
  const getVisibleAgents =
    options.getVisibleAgents ??
    ((category) => listRuntimeAgents({ category, visibleOnly: true }));

  const state: SettingsAgentCatalogState = {
    getEnabledAgentKeys: (category) =>
      workspaceState.get<string[]>(agentStateKey(category)),
    setEnabledAgentKeys: async (category, enabledKeys) => {
      await workspaceState.update(agentStateKey(category), enabledKeys);
    },
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
  };

  const catalog = new SettingsAgentCatalogController({
    state,
    loadAgents: options.loadAgents ?? loadRuntimeAgents,
    builtInOrchestratorAgentNames:
      options.builtInOrchestratorAgentNames ??
      RUNTIME_BUILTIN_TEAM_ROOT_AGENT_NAMES,
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
      getAgent: (source, name) => getRuntimeAgent(`${source}:${name}`) ?? null,
    },
  });
  const visibility = new SettingsAgentVisibilityController({
    state: {
      getEnabledAgentKeys: state.getEnabledAgentKeys,
      setEnabledAgentKeys: state.setEnabledAgentKeys,
      getAgents: (category) =>
        getAgents(category).map((entry) => ({
          source: entry.source,
          name: entry.name,
        })),
    },
  });

  return { catalog, directory, visibility, state };
}
