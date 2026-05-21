/**
 * Agent selection / directory / preset outbound message builders.
 *
 * The heavy lifting is in `SettingsAgentCatalogController` and
 * `SettingsAgentDirectoryController`; this module wraps their outputs in
 * the wire-message shape that both hosts post identically.
 */
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import type {
  UpdateAgentModePresetsMessage,
  UpdateAgentSelectionMessage,
  UpdateCustomAgentDirMessage,
} from '@shared/schemas/settingsViewMessages';
import type { SettingsAgentCatalogController } from '@controllers/settingsView/SettingsAgentCatalogController';
import type { SettingsAgentDirectoryController } from '@controllers/settingsView/SettingsAgentDirectoryController';

/**
 * Caller must call `loadAgents()` (or a host-supplied equivalent) before
 * invoking this builder so the registry is populated. Kept out of the
 * shared function to honour the desktop's overridable `loadAgents` hook.
 */
export function buildAgentSelectionMessage(
  catalog: SettingsAgentCatalogController,
): UpdateAgentSelectionMessage {
  const { workflow, toolUse } = catalog.buildSelectionItems();
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
    workflow,
    toolUse,
  };
}

export async function buildCustomAgentDirMessage(
  directory: SettingsAgentDirectoryController,
): Promise<UpdateCustomAgentDirMessage> {
  const status = await directory.getCustomDirStatus();
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR,
    ...status,
  };
}

export function buildAgentModePresetsMessage(
  catalog: SettingsAgentCatalogController,
): UpdateAgentModePresetsMessage {
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
    customPresets: catalog.getCustomPresets(),
  };
}
