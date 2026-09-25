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
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  type SettingsSectionName,
  type SettingsTabPanelName,
  type SettingsViewOutboundHandlerRegistry,
} from '@shared/settingsView/settingsViewMessages';

import {
  activePresetId,
  agentSelectionItems,
  agentSubTab,
  applySettingsSnapshot,
  authenticated,
  copilotRouteInfos,
  customAgentDir,
  customAgentDirIsDefault,
  customAgentScanIssues,
  customPresets,
  githubTokenStatus,
  gitSettingsLoaded,
  helperModel,
  latexSettingsLoaded,
  latexSettingsStatus,
  memoryItems,
  modelSelectionItems,
  multiAgentSettingsRevision,
  orchestratorAgents,
  preferShortModelNames,
  prSubscriptions,
  providerKeyStatuses,
  selectedPanel,
  selectedSections,
  sessionProblem,
  skillLoadIssues,
  skillsList,
  subscriptionAuth,
  subscriptionUsage,
  toolDashboardItems,
  toolDashboardLoaded,
  userEmail,
} from './settingsState';

export const settingsViewHandlers: SettingsViewOutboundHandlerRegistry = {
  // View chrome: active tab and the derived capability gating across tabs.
  [SETTINGS_VIEW_COMMANDS.SET_TAB]: (data) => {
    // The schema admits only `page` or a `page/section` pair it declares.
    const [page, section] = data.tab.split('/') as [
      SettingsTabPanelName,
      SettingsSectionName?,
    ];
    selectedPanel.set(page);
    if (section)
      selectedSections.set({ ...selectedSections.get(), [page]: section });
    agentSubTab.set(data.agentSubTab);
  },

  // Memory.
  [SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY]: (data) => {
    memoryItems.set(data.items);
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW]: (data) => {
    const { storagePath, preview, lineCount, error } = data.preview;
    memoryItems.set(
      memoryItems.get().map((item) => {
        if (item.storagePath !== storagePath) return item;
        if (error) {
          return {
            ...item,
            preview: undefined,
            lineCount: undefined,
            previewError: true,
          };
        }
        return {
          ...item,
          preview,
          lineCount: lineCount ?? item.lineCount,
          previewError: undefined,
        };
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
    applySettingsSnapshot(data.values);
    if (data.snapshot === 'git-author') gitSettingsLoaded.set(true);
    if (data.snapshot === 'multi-agent') {
      multiAgentSettingsRevision.set(multiAgentSettingsRevision.get() + 1);
    }
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

  [SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_AUTH_STATUS]: (data) => {
    subscriptionAuth.set({
      ...subscriptionAuth.get(),
      [data.status.provider]: data.status,
    });
  },

  [SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS]: (data) => {
    prSubscriptions.set(data.subscriptions);
  },

  // Subscription usage.
  [SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE]: (data) => {
    subscriptionUsage.set(data.snapshots);
  },

  // LaTeX settings status. The LaTeX config values themselves arrive through
  // UPDATE_SETTINGS_SNAPSHOT above; these two carry the toolchain status the
  // LaTeX tab renders around them.
  [SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS]: (data) => {
    latexSettingsStatus.set(data.settings);
    latexSettingsLoaded.set(true);
  },
};
