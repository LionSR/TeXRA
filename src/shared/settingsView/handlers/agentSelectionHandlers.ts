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
import { Effect } from 'effect';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { AgentModePreset, ByCategory } from '@shared/schemas';
import type {
  AgentScanIssue,
  AgentSelectionItem,
  UpdateAgentModePresetsMessage,
  UpdateAgentSelectionMessage,
  UpdateCustomAgentDirMessage,
} from '@shared/settingsView/settingsViewMessages';

export interface AgentSelectionPorts {
  buildSelectionItems(): ByCategory<AgentSelectionItem[]>;
  getCustomAgentScanIssues(): readonly AgentScanIssue[];
}

export function buildAgentSelectionMessage(
  ports: AgentSelectionPorts,
): UpdateAgentSelectionMessage {
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
    agents: ports.buildSelectionItems(),
    customAgentIssues: [...ports.getCustomAgentScanIssues()],
  };
}

/** The status reader is the directory controller's Effect; its failure stays
 *  the caller's to report, which is why `E` is left open here. */
export interface CustomAgentDirPorts<E, R = never> {
  getCustomDirStatus(): Effect.Effect<
    { path: string; isDefault: boolean },
    E,
    R
  >;
}

export function buildCustomAgentDirMessage<E, R = never>(
  ports: CustomAgentDirPorts<E, R>,
): Effect.Effect<UpdateCustomAgentDirMessage, E, R> {
  return Effect.map(ports.getCustomDirStatus(), (status) => ({
    command: SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR,
    ...status,
  }));
}

export interface AgentModePresetsPorts {
  getCustomPresets(): AgentModePreset[];
  getOrchestratorAgentNames(): string[];
  getActiveTeamId(): string | null;
}

export function buildAgentModePresetsMessage(
  ports: AgentModePresetsPorts,
): UpdateAgentModePresetsMessage {
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
    customPresets: ports.getCustomPresets(),
    orchestratorAgents: ports.getOrchestratorAgentNames(),
    activePresetId: ports.getActiveTeamId(),
  };
}
