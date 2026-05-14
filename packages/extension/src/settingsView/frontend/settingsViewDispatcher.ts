import { SETTINGS_VIEW_COMMANDS } from '@common/webview/commands';
import {
  HistoryClearedMessageSchema,
  SetTabMessageSchema,
  UpdateAgentModePresetsMessageSchema,
  UpdateAgentSelectionMessageSchema,
  UpdateApprovalSettingsMessageSchema,
  UpdateCustomAgentDirMessageSchema,
  UpdateGitAuthorSettingsMessageSchema,
  UpdateDesktopCrashReportingMessageSchema,
  UpdateGitHubTokenStatusMessageSchema,
  UpdateHistoryMessageSchema,
  UpdateLatexConfigValuesMessageSchema,
  UpdateInlineCriticismEnabledMessageSchema,
  UpdateLatexSettingsStatusMessageSchema,
  UpdateMemoryEnabledMessageSchema,
  UpdateMemoryMessageSchema,
  UpdateMemoryPreviewMessageSchema,
  UpdateModelSelectionMessageSchema,
  UpdatePRSubscriptionsMessageSchema,
  UpdateProfileMessageSchema,
  UpdateSuperYoloEnabledMessageSchema,
  UpdateToolDashboardMessageSchema,
  type AgentSelectionItem,
  type HistoryItem,
  type LatexConfigValues,
  type LatexSettingsStatus,
  type MemoryViewItem,
  type ModelSelectionItem,
  type NumberVscodeSetting,
  type PRSubscriptionEntry,
  type ProviderKeyStatus,
  type ToolDashboardItem,
} from '@shared/schemas';
import type { AgentCategory } from '@shared/schemas/agent';
import type { AgentModePreset } from '@shared/schemas/agentPresets';

interface WritableSignal<T> {
  get(): T;
  set(value: T): void;
}

interface MessageSchema<T> {
  safeParse(
    data: unknown,
  ): { success: true; data: T } | { success: false; error: unknown };
}

export interface SettingsMessageHandlerContext {
  selectedTabIndex: WritableSignal<number>;
  memoryItems: WritableSignal<MemoryViewItem[]>;
  memoryEnabled: WritableSignal<boolean>;
  memoryToggleDisabled: WritableSignal<boolean>;
  historyItems: WritableSignal<HistoryItem[]>;
  authenticated: WritableSignal<boolean>;
  userEmail: WritableSignal<string>;
  tier: WritableSignal<string>;
  apiAccessMode: WritableSignal<'included' | 'personal'>;
  allowedModels: WritableSignal<string[] | null>;
  providerKeyStatuses: WritableSignal<ProviderKeyStatus[]>;
  globalStreamingDefault: WritableSignal<boolean>;
  modelSelectionItems: WritableSignal<ModelSelectionItem[]>;
  helperModel: WritableSignal<string>;
  preferShortModelNames: WritableSignal<boolean>;
  workflowAgents: WritableSignal<AgentSelectionItem[]>;
  toolUseAgents: WritableSignal<AgentSelectionItem[]>;
  customAgentDir: WritableSignal<string>;
  customAgentDirIsDefault: WritableSignal<boolean>;
  agentSubTab: WritableSignal<AgentCategory | undefined>;
  customPresets: WritableSignal<AgentModePreset[]>;
  reliabilitySettings: WritableSignal<NumberVscodeSetting[]>;
  allowOrchestratorKill: WritableSignal<boolean>;
  detachSubagentsOnStop: WritableSignal<boolean>;
  nestedDelegationMaxDepth: WritableSignal<number>;
  bashApprovalEnabled: WritableSignal<boolean>;
  codexSandboxMode: WritableSignal<string>;
  codexReasoningEffort: WritableSignal<string>;
  codexApprovalPolicy: WritableSignal<string>;
  claudeAgentModel: WritableSignal<string>;
  claudeAgentPermissionMode: WritableSignal<string>;
  toolDashboardItems: WritableSignal<ToolDashboardItem[]>;
  toolDashboardLoaded: WritableSignal<boolean>;
  gitMarkCommits: WritableSignal<boolean>;
  gitAuthorName: WritableSignal<string>;
  gitAuthorEmail: WritableSignal<string>;
  gitWorktreeSupport: WritableSignal<boolean>;
  gitSettingsLoaded: WritableSignal<boolean>;
  githubTokenStatus: WritableSignal<'secret' | 'env' | 'none'>;
  desktopCrashReportingEnabled: WritableSignal<boolean>;
  desktopCrashReportingConfigured: WritableSignal<boolean>;
  prSubscriptions: WritableSignal<readonly PRSubscriptionEntry[]>;
  latexSettingsStatus: WritableSignal<LatexSettingsStatus>;
  latexSettingsLoaded: WritableSignal<boolean>;
  latexConfigValues: WritableSignal<LatexConfigValues>;
  latexConfigValuesLoaded: WritableSignal<boolean>;
  inlineCriticismEnabled: WritableSignal<boolean>;
  clearHistorySearch(): void;
  logSchemaError(message: string, error: unknown): void;
}

function parseMessage<T>(
  raw: unknown,
  schema: MessageSchema<T>,
  ctx: SettingsMessageHandlerContext,
): T | null {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const command =
      raw && typeof raw === 'object' && 'command' in raw
        ? String((raw as { command: unknown }).command)
        : 'unknown';
    ctx.logSchemaError(
      `[settingsViewDispatcher] Message validation failed for command "${command}".`,
      result.error,
    );
    return null;
  }
  return result.data;
}

export function dispatchSettingsViewMessage(
  raw: unknown,
  ctx: SettingsMessageHandlerContext,
): boolean {
  if (!raw || typeof raw !== 'object' || !('command' in raw)) {
    return false;
  }

  const command = (raw as { command: string }).command;

  switch (command) {
    case SETTINGS_VIEW_COMMANDS.SET_TAB: {
      const data = parseMessage(raw, SetTabMessageSchema, ctx);
      if (!data) return false;
      ctx.selectedTabIndex.set(data.tabIndex);
      ctx.agentSubTab.set(data.agentSubTab);
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY: {
      const data = parseMessage(raw, UpdateMemoryMessageSchema, ctx);
      if (!data) return false;
      ctx.memoryItems.set(data.items ?? []);
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED: {
      const data = parseMessage(raw, UpdateMemoryEnabledMessageSchema, ctx);
      if (!data) return false;
      ctx.memoryEnabled.set(data.enabled);
      ctx.memoryToggleDisabled.set(false);
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW: {
      const data = parseMessage(raw, UpdateMemoryPreviewMessageSchema, ctx);
      if (!data) return false;
      const { storagePath, preview, lineCount, error } = data.preview;
      ctx.memoryItems.set(
        ctx.memoryItems.get().map((item) =>
          item.storagePath === storagePath
            ? error
              ? {
                  ...item,
                  preview: undefined,
                  lineCount: undefined,
                  previewError: true,
                }
              : {
                  ...item,
                  preview,
                  ...(lineCount === undefined ? {} : { lineCount }),
                  previewError: undefined,
                }
            : item,
        ),
      );
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_HISTORY: {
      const data = parseMessage(raw, UpdateHistoryMessageSchema, ctx);
      if (!data) return false;
      ctx.historyItems.set(
        [...data.historyItems].sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        ),
      );
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.HISTORY_CLEARED: {
      const data = parseMessage(raw, HistoryClearedMessageSchema, ctx);
      if (!data) return false;
      ctx.historyItems.set([]);
      ctx.clearHistorySearch();
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION: {
      const data = parseMessage(raw, UpdateModelSelectionMessageSchema, ctx);
      if (!data) return false;
      ctx.modelSelectionItems.set(data.models);
      ctx.helperModel.set(data.helperModel);
      ctx.preferShortModelNames.set(data.preferShortModelNames);
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION: {
      const data = parseMessage(raw, UpdateAgentSelectionMessageSchema, ctx);
      if (!data) return false;
      ctx.workflowAgents.set(data.workflow);
      ctx.toolUseAgents.set(data.toolUse);
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR: {
      const data = parseMessage(raw, UpdateCustomAgentDirMessageSchema, ctx);
      if (!data) return false;
      ctx.customAgentDir.set(data.path);
      ctx.customAgentDirIsDefault.set(data.isDefault);
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED: {
      const data = parseMessage(raw, UpdateSuperYoloEnabledMessageSchema, ctx);
      if (!data) return false;
      ctx.reliabilitySettings.set(data.reliabilitySettings);
      ctx.allowOrchestratorKill.set(data.allowOrchestratorKill);
      ctx.detachSubagentsOnStop.set(data.detachSubagentsOnStop);
      ctx.nestedDelegationMaxDepth.set(data.nestedDelegationMaxDepth);
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS: {
      const data = parseMessage(raw, UpdateAgentModePresetsMessageSchema, ctx);
      if (!data) return false;
      ctx.customPresets.set(data.customPresets);
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS: {
      const data = parseMessage(raw, UpdateApprovalSettingsMessageSchema, ctx);
      if (!data) return false;
      ctx.bashApprovalEnabled.set(data.bashApprovalEnabled);
      ctx.codexSandboxMode.set(data.codexSandboxMode);
      ctx.codexReasoningEffort.set(data.codexReasoningEffort);
      ctx.codexApprovalPolicy.set(data.codexApprovalPolicy);
      ctx.claudeAgentModel.set(data.claudeAgentModel);
      ctx.claudeAgentPermissionMode.set(data.claudeAgentPermissionMode);
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD: {
      const data = parseMessage(raw, UpdateToolDashboardMessageSchema, ctx);
      if (!data) return false;
      ctx.toolDashboardItems.set(data.items);
      ctx.toolDashboardLoaded.set(true);
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS: {
      const data = parseMessage(raw, UpdateGitAuthorSettingsMessageSchema, ctx);
      if (!data) return false;
      ctx.gitMarkCommits.set(data.markCommits);
      ctx.gitAuthorName.set(data.authorName);
      ctx.gitAuthorEmail.set(data.authorEmail);
      ctx.gitWorktreeSupport.set(data.worktreeSupport);
      ctx.gitSettingsLoaded.set(true);
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_GITHUB_TOKEN_STATUS: {
      const data = parseMessage(raw, UpdateGitHubTokenStatusMessageSchema, ctx);
      if (!data) return false;
      ctx.githubTokenStatus.set(data.status);
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_DESKTOP_CRASH_REPORTING: {
      const data = parseMessage(
        raw,
        UpdateDesktopCrashReportingMessageSchema,
        ctx,
      );
      if (!data) return false;
      ctx.desktopCrashReportingEnabled.set(data.enabled);
      ctx.desktopCrashReportingConfigured.set(data.configured);
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_PR_SUBSCRIPTIONS: {
      const data = parseMessage(raw, UpdatePRSubscriptionsMessageSchema, ctx);
      if (!data) return false;
      ctx.prSubscriptions.set(data.subscriptions);
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_SETTINGS_STATUS: {
      const data = parseMessage(
        raw,
        UpdateLatexSettingsStatusMessageSchema,
        ctx,
      );
      if (!data) return false;
      ctx.latexSettingsStatus.set(data.settings);
      ctx.latexSettingsLoaded.set(true);
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES: {
      const data = parseMessage(raw, UpdateLatexConfigValuesMessageSchema, ctx);
      if (!data) return false;
      ctx.latexConfigValues.set(data.values);
      ctx.latexConfigValuesLoaded.set(true);
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_INLINE_CRITICISM_ENABLED: {
      const data = parseMessage(
        raw,
        UpdateInlineCriticismEnabledMessageSchema,
        ctx,
      );
      if (!data) return false;
      ctx.inlineCriticismEnabled.set(data.enabled);
      return true;
    }

    case SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE: {
      const data = parseMessage(raw, UpdateProfileMessageSchema, ctx);
      if (!data) return false;
      ctx.authenticated.set(data.authenticated);
      ctx.userEmail.set(data.user?.email ?? 'N/A');
      ctx.tier.set(data.tier ?? 'free');
      ctx.apiAccessMode.set(data.apiAccessMode);
      ctx.allowedModels.set(data.allowedModels ?? null);
      ctx.providerKeyStatuses.set(data.providerKeyStatuses ?? []);
      ctx.globalStreamingDefault.set(data.globalStreamingDefault ?? true);
      return true;
    }
  }

  return false;
}
