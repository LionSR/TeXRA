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
  getAgent,
  getToolUseAgents,
  getWorkflowAgents,
  getVisibleAgents as getVisibleRegistryAgents,
  type AgentEntry,
} from '@agent/index/agentRegistry';
import { GlobalStateKey, WorkspaceStateKey } from '@common/state/stateKeys';
import type { AgentCategory, AgentSource } from '@shared/schemas/agent';

import type { SettingsStatePorts } from './types';

export interface AgentControllerFactoryOptions extends SettingsStatePorts {
  readonly getCustomAgentDirectory: () => Promise<string>;
  readonly getSourceDirectory: (
    source: AgentSource,
  ) => Promise<string | undefined>;
  readonly getAgents?: (category: AgentCategory) => AgentEntry[];
  readonly getVisibleAgents?: (category: AgentCategory) => AgentEntry[];
}

export interface SettingsAgentControllers {
  readonly catalog: SettingsAgentCatalogController;
  readonly directory: SettingsAgentDirectoryController;
  readonly visibility: SettingsAgentVisibilityController;
  readonly state: SettingsAgentCatalogState;
}

function defaultGetAgents(category: AgentCategory): AgentEntry[] {
  return category === 'workflow' ? getWorkflowAgents() : getToolUseAgents();
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
  const getAgents = options.getAgents ?? defaultGetAgents;
  const getVisibleAgents = options.getVisibleAgents ?? getVisibleRegistryAgents;

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

  const catalog = new SettingsAgentCatalogController({ state });
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
      getAgent: (source, name) => getAgent(`${source}:${name}`) ?? null,
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
