/**
 * Single-command, single-toggle handlers with no state section of their own:
 * agent skills, telemetry, goals, agent teams, tool dashboard, multi-agent
 * coordination. Bundled here rather than split one-file-per-command; see
 * ../messageDispatcher.ts for why modelSelectionSlice.ts and
 * approvalSettingsSlice.ts (also single-command) stay separate.
 */
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  applySettingsSnapshot,
  customPresets,
  goalItems,
  multiAgentSettingsRevision,
  orchestratorAgents,
  toolDashboardItems,
  toolDashboardLoaded,
} from '../settingsState';

export const agentSkillsSettingsHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SKILLS_SETTINGS]: (data) => {
    applySettingsSnapshot(data.values);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;

export const telemetrySettingsHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_TELEMETRY_SETTINGS]: (data) => {
    applySettingsSnapshot(data.values);
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
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;

export const toolDashboardHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD]: (data) => {
    toolDashboardItems.set(data.items);
    toolDashboardLoaded.set(true);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;

export const multiAgentHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED]: (data) => {
    applySettingsSnapshot(data.values);
    multiAgentSettingsRevision.set(multiAgentSettingsRevision.get() + 1);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
