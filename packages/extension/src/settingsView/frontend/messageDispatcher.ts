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
  LATEX_CONFIG_KEYS,
  type LatexConfigValues,
} from '@shared/constants/latexConfig';
import {
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
  goalItems,
  helperModel,
  inlineCriticismEnabled,
  latexConfigValues,
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
  sessionProblem,
  skillLoadIssues,
  skillsList,
  subscriptionAuth,
  subscriptionUsage,
  toolDashboardItems,
  toolDashboardLoaded,
  unsupportedCommands,
  userEmail,
} from './settingsState';

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
    if (data.snapshot === 'latex') {
      // The LaTeX tab renders its own keyed record rather than the catalog
      // signals, so it takes the payload whole: every row the snapshot carries
      // reaches the tab, including one added after this line was written. A
      // row with no field, or a field whose key left the catalog, is reported
      // rather than rendering a default forever — the same guarantee
      // `applySettingsSnapshot` gives the other snapshots.
      const unrendered = new Set(Object.keys(LATEX_CONFIG_KEYS));
      for (const key of Object.keys(data.values)) {
        if (!unrendered.delete(key)) {
          console.warn(
            `[settings] The LaTeX tab declares no field for catalog setting "${key}"; it cannot render it.`,
          );
        }
      }
      for (const key of unrendered) {
        console.warn(
          `[settings] The LaTeX tab renders "${key}", which the LaTeX snapshot does not carry; it will show its default.`,
        );
      }
      latexConfigValues.set(data.values as LatexConfigValues);
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

  [SETTINGS_VIEW_COMMANDS.UPDATE_INLINE_CRITICISM_ENABLED]: (data) => {
    inlineCriticismEnabled.set(data.enabled);
  },
};
