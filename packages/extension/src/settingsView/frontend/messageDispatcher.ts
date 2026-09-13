/**
 * Outbound message-handler registry for SettingsView.
 *
 * Backend → webview messages are validated and routed by
 * `dispatchSettingsViewOutbound` (`@shared/utils/dispatcher`); every handler
 * lives in the one registry below, which the
 * `SettingsViewOutboundHandlerRegistry` annotation keeps exhaustive — a
 * missing or unknown command is a compile error. Handlers mutate the
 * module-level signals in `settingsState.ts` directly.
 */
import { create } from 'mutative';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { LATEX_CONFIG_FIELD_TO_KEY } from '@shared/constants/latexConfig';
import {
  LatexConfigValuesSchema,
  type SettingsViewOutboundHandlerRegistry,
} from '@shared/schemas';

import {
  activePresetId,
  agentSelectionItems,
  agentSubTab,
  applySettingsSnapshot,
  authenticated,
  chatgptAuth,
  copilotRouteInfos,
  customAgentDir,
  customAgentDirIsDefault,
  customAgentScanIssues,
  customPresets,
  githubTokenStatus,
  gitSettingsLoaded,
  globalStreamingDefault,
  goalItems,
  grokAuth,
  helperModel,
  latexConfigValues,
  memoryItems,
  modelSelectionItems,
  multiAgentSettingsRevision,
  orchestratorAgents,
  preferShortModelNames,
  prSubscriptions,
  providerKeyStatuses,
  selectedPanel,
  sessionProblem,
  skillLoadIssues,
  skillsList,
  subscriptionUsage,
  toolDashboardItems,
  toolDashboardLoaded,
  unsupportedCommands,
  userEmail,
} from './settingsState';
import { latexHandlers } from './slices/latexSlice';

export const settingsViewHandlers: SettingsViewOutboundHandlerRegistry = {
  // View chrome: active tab and the derived capability gating across tabs.
  [SETTINGS_VIEW_COMMANDS.SET_TAB]: (data) => {
    selectedPanel.set(data.tab);
    agentSubTab.set(data.agentSubTab);
  },

  [SETTINGS_VIEW_COMMANDS.SET_UNSUPPORTED_COMMANDS]: (data) => {
    unsupportedCommands.set(new Set(data.commands));
  },

  // Memory.
  [SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY]: (data) => {
    memoryItems.set(data.items);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW]: (data) => {
    const { storagePath, preview, lineCount, error } = data.preview;
    memoryItems.set(
      create(memoryItems.get(), (draft) => {
        const item = draft.find((entry) => entry.storagePath === storagePath);
        if (!item) return;
        if (error) {
          item.preview = undefined;
          item.lineCount = undefined;
          item.previewError = true;
        } else {
          item.preview = preview;
          if (lineCount !== undefined) item.lineCount = lineCount;
          item.previewError = undefined;
        }
      }),
    );
  },

  // Profile.
  [SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE]: (data) => {
    authenticated.set(data.authenticated);
    userEmail.set(data.user?.email ?? '');
    // Fields declared with `.prefault()` in UpdateProfileMessageSchema are
    // guaranteed present by the validating dispatcher — no fallback needed.
    sessionProblem.set(data.sessionProblem);
    providerKeyStatuses.set(data.providerKeyStatuses);
    globalStreamingDefault.set(data.globalStreamingDefault);
  },

  // Model selection.
  [SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION]: (data) => {
    modelSelectionItems.set(data.models);
    helperModel.set(data.helperModel);
    preferShortModelNames.set(data.preferShortModelNames);
    copilotRouteInfos.set(data.copilotModels);
  },

  // Agent selection.
  [SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION]: (data) => {
    agentSelectionItems.set(data.agents);
    customAgentScanIssues.set(data.customAgentIssues);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR]: (data) => {
    customAgentDir.set(data.path);
    customAgentDirIsDefault.set(data.isDefault);
  },

  // Skills.
  [SETTINGS_VIEW_COMMANDS.UPDATE_SKILLS_LIST]: (data) => {
    skillsList.set(data.skills);
    skillLoadIssues.set(data.issues);
  },

  // Catalog-derived settings snapshots.
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

  // Goals.
  [SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST]: (data) => {
    goalItems.set(data.items);
  },

  // Agent teams.
  [SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS]: (data) => {
    customPresets.set(data.customPresets);
    orchestratorAgents.set(data.orchestratorAgents);
    activePresetId.set(data.activePresetId);
  },

  // Tool dashboard.
  [SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD]: (data) => {
    toolDashboardItems.set(data.items);
    toolDashboardLoaded.set(true);
  },

  // Git and integration auth.
  [SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS]: (data) => {
    githubTokenStatus.set(data.status);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS]: (data) => {
    chatgptAuth.set(data.status);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_GROK_AUTH_STATUS]: (data) => {
    grokAuth.set(data.status);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS]: (data) => {
    prSubscriptions.set(data.subscriptions);
  },

  // Subscription usage.
  [SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE]: (data) => {
    subscriptionUsage.set(data.snapshots);
  },

  // LaTeX settings status — still a slice module while the LaTeX wire
  // projection is being reworked; fold it in here once that lands.
  ...latexHandlers,
};
