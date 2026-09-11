/**
 * Handlers with no state section of their own: every catalog-derived
 * settings snapshot, goals, agent teams, and the tool dashboard. Bundled here
 * rather than split one-file-per-command; see ../messageDispatcher.ts for why
 * modelSelectionSlice.ts (also single-command) stays separate.
 */
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  LatexConfigValuesSchema,
  type SettingsViewOutboundHandlerRegistry,
} from '@shared/schemas';
import { LATEX_CONFIG_FIELD_TO_KEY } from '@shared/constants/latexConfig';

import {
  activePresetId,
  applySettingsSnapshot,
  customPresets,
  gitSettingsLoaded,
  goalItems,
  latexConfigValues,
  multiAgentSettingsRevision,
  orchestratorAgents,
  toolDashboardItems,
  toolDashboardLoaded,
} from '../settingsState';

export const settingsSnapshotHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT]: (data) => {
    if (data.snapshot === 'latex') {
      latexConfigValues.set(
        LatexConfigValuesSchema.parse(
          Object.fromEntries(
            Object.entries(LATEX_CONFIG_FIELD_TO_KEY).map(([field, key]) => [
              field,
              data.values[key],
            ]),
          ),
        ),
      );
      return;
    }
    applySettingsSnapshot(data.values);
    if (data.snapshot === 'git-author') gitSettingsLoaded.set(true);
    if (data.snapshot === 'multi-agent') {
      multiAgentSettingsRevision.set(multiAgentSettingsRevision.get() + 1);
    }
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;

export const goalHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST]: (data) => {
    goalItems.set(data.items);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;

export const agentTeamsHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS]: (data) => {
    customPresets.set(data.customPresets);
    orchestratorAgents.set(data.orchestratorAgents);
    activePresetId.set(data.activePresetId);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;

export const toolDashboardHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD]: (data) => {
    toolDashboardItems.set(data.items);
    toolDashboardLoaded.set(true);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
