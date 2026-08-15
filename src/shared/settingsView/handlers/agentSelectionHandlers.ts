/**
 * Agent selection / custom-directory / mode-preset outbound message builders.
 *
 * Both the extension and desktop hosts build these from the same
 * `SettingsAgentCatalogController`/`SettingsAgentDirectoryController` calls;
 * centralizing the message shape here means the wire format can't drift
 * between hosts. Callers supply the controller methods as plain ports (not
 * the controller classes themselves) so this file stays free of `@controllers/*`
 * imports, per `SharedSettingsViewBoundary.vitest.ts`.
 */
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  AgentModePreset,
  AgentSelectionItem,
  ByCategory,
  UpdateAgentModePresetsMessage,
  UpdateAgentSelectionMessage,
  UpdateCustomAgentDirMessage,
} from '@shared/schemas';

export interface AgentSelectionPorts {
  loadAgents(): Promise<void>;
  buildSelectionItems(): ByCategory<AgentSelectionItem[]>;
}

export async function buildAgentSelectionMessage(
  ports: AgentSelectionPorts,
): Promise<UpdateAgentSelectionMessage> {
  await ports.loadAgents();
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
    agents: ports.buildSelectionItems(),
  };
}

export interface CustomAgentDirPorts {
  getCustomDirStatus(): Promise<{ path: string; isDefault: boolean }>;
}

export async function buildCustomAgentDirMessage(
  ports: CustomAgentDirPorts,
): Promise<UpdateCustomAgentDirMessage> {
  const status = await ports.getCustomDirStatus();
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR,
    ...status,
  };
}

export interface AgentModePresetsPorts {
  getCustomPresets(): AgentModePreset[];
  getOrchestratorAgentNames(): string[];
}

export function buildAgentModePresetsMessage(
  ports: AgentModePresetsPorts,
): UpdateAgentModePresetsMessage {
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
    customPresets: ports.getCustomPresets(),
    orchestratorAgents: ports.getOrchestratorAgentNames(),
  };
}
