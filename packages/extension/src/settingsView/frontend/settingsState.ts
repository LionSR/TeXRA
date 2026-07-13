/**
 * Module-level reactive state for the Settings view.
 *
 * Hoisted from `SettingsApp` private instance fields onto module scope,
 * mirroring the Progress view's `progressState.ts` (audit item A3). Unlike
 * `progressState.ts`, there is no monolithic nested state object here — each
 * signal below was already an independent, flat piece of state (no shared
 * per-stream Map indirection), so slices import and set the specific signals
 * they need directly instead of going through a generic get/set context.
 *
 * SettingsApp has no persistence/restore path: every signal here is written
 * only by the composed `messageHandlers` registry (see `messageDispatcher.ts`
 * + `slices/`) in response to backend SETTINGS_VIEW_COMMANDS messages — the
 * backend/VS Code config is the actual source of truth, this file is a pure
 * receiver.
 *
 * Singleton scope: only one Settings view per webview/page. If we ever need
 * multiple independent settings instances on the same page, this file must be
 * promoted to a per-instance store.
 */

import { signal } from '@shared/signals';
import type {
  MemoryViewItem,
  HistoryItem,
  ProviderKeyStatus,
  ModelSelectionItem,
} from '@shared/schemas';
import type { SpendingStatus } from '@shared/schemas/spendingStatus';
import {
  type AgentSelectionItem,
  type ClaudeAgentEffort,
  type ClaudeAgentModel,
  type ClaudeAgentPermissionMode,
  type LatexConfigValues,
  type NumberVscodeSetting,
  type Goal,
  type PRSubscriptionEntry,
  type ToolDashboardItem,
  type ChatGptAuthStatus,
  DEFAULT_LATEX_SETTINGS_STATUS,
} from '@shared/schemas/settingsViewMessages';
import {
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_MARK_COMMITS,
} from '@shared/constants/git';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import type { AgentCategory } from '@shared/schemas/agent';
import type { AgentModePreset } from '@shared/schemas/agentPresets';
import { CLAUDE_AGENT_DEFAULT_MODEL } from '@shared/schemas/agentCliSettings';

/** Target for the desktop-host "set provider key" modal. */
export interface ProviderKeyModalTarget {
  provider: string;
  displayName: string;
}

const DEFAULT_CHATGPT_AUTH: ChatGptAuthStatus = {
  signedIn: false,
  preferSubscription: false,
  subscriptionToolUseOnly: false,
};

// ---------------------------------------------------------------------------
// Tab state
// ---------------------------------------------------------------------------
export const selectedTabIndex = signal(0);

// ---------------------------------------------------------------------------
// Memory state
// ---------------------------------------------------------------------------
export const memoryItems = signal<MemoryViewItem[]>([]);
export const memoryEnabled = signal(false);
export const memoryToggleDisabled = signal(true);

// ---------------------------------------------------------------------------
// History state
// ---------------------------------------------------------------------------
export const historyItems = signal<HistoryItem[]>([]);

// ---------------------------------------------------------------------------
// Profile state
// ---------------------------------------------------------------------------
export const authenticated = signal(false);
export const userEmail = signal('');
export const tier = signal('free');
export const apiAccessMode = signal<'included' | 'personal'>('personal');
export const spendingStatus = signal<SpendingStatus | null>(null);
export const quotaAutoSwitched = signal(false);
export const providerKeyStatuses = signal<ProviderKeyStatus[]>([]);
export const globalStreamingDefault = signal(true);
export const providerKeyModal = signal<ProviderKeyModalTarget | null>(null);

// ---------------------------------------------------------------------------
// Model selection state
// ---------------------------------------------------------------------------
export const modelSelectionItems = signal<ModelSelectionItem[]>([]);
export const helperModel = signal(DEFAULT_HELPER_MODEL);
export const preferShortModelNames = signal(false);

// ---------------------------------------------------------------------------
// Agent selection state
// ---------------------------------------------------------------------------
export const workflowAgents = signal<AgentSelectionItem[]>([]);
export const toolUseAgents = signal<AgentSelectionItem[]>([]);
export const customAgentDir = signal('');
export const customAgentDirIsDefault = signal(true);
export const agentSubTab = signal<AgentCategory | undefined>(undefined);

// ---------------------------------------------------------------------------
// Agent teams state
// ---------------------------------------------------------------------------
export const customPresets = signal<AgentModePreset[]>([]);
export const orchestratorAgents = signal<string[]>([]);

// ---------------------------------------------------------------------------
// Multi-agent coordination state
// ---------------------------------------------------------------------------
export const reliabilitySettings = signal<NumberVscodeSetting[]>([]);
export const allowOrchestratorKill = signal(true);
export const detachSubagentsOnStop = signal(false);

// ---------------------------------------------------------------------------
// Approval settings state
// ---------------------------------------------------------------------------
export const bashApprovalEnabled = signal(true);
export const codexSandboxMode = signal<string>('workspace-write');
export const codexReasoningEffort = signal<string>('high');
export const codexApprovalPolicy = signal<string>('never');
export const claudeAgentModel = signal<ClaudeAgentModel>(
  CLAUDE_AGENT_DEFAULT_MODEL,
);
export const claudeAgentPermissionMode =
  signal<ClaudeAgentPermissionMode>('acceptEdits');
export const claudeAgentEffort = signal<ClaudeAgentEffort>('high');

// ---------------------------------------------------------------------------
// Tool dashboard state
// ---------------------------------------------------------------------------
export const toolDashboardItems = signal<ToolDashboardItem[]>([]);
export const toolDashboardLoaded = signal(false);

// ---------------------------------------------------------------------------
// Git author settings state
// ---------------------------------------------------------------------------
export const gitMarkCommits = signal(DEFAULT_GIT_MARK_COMMITS);
export const gitAuthorName = signal(DEFAULT_GIT_AUTHOR_NAME);
export const gitAuthorEmail = signal(DEFAULT_GIT_AUTHOR_EMAIL);
export const gitWorktreeSupport = signal(false);
export const gitSettingsLoaded = signal(false);
export const githubTokenStatus = signal<'secret' | 'env' | 'none'>('none');
export const chatgptAuth = signal<ChatGptAuthStatus>({
  ...DEFAULT_CHATGPT_AUTH,
});
export const desktopCrashReportingEnabled = signal(false);
export const desktopCrashReportingConfigured = signal(false);
export const prSubscriptions = signal<readonly PRSubscriptionEntry[]>([]);

// ---------------------------------------------------------------------------
// LaTeX settings state
// ---------------------------------------------------------------------------
export const latexSettingsStatus = signal({
  ...DEFAULT_LATEX_SETTINGS_STATUS,
});
export const latexSettingsLoaded = signal(false);
export const latexConfigValues = signal<LatexConfigValues>({});
export const latexConfigValuesLoaded = signal(false);
export const inlineCriticismEnabled = signal(false);

// ---------------------------------------------------------------------------
// Goal settings state
// ---------------------------------------------------------------------------
export const goalItems = signal<readonly Goal[]>([]);

// ---------------------------------------------------------------------------
// Derived capability view: commands the active host's inbound registry
// declares `unsupported(...)`, sent once at webview-ready (see
// `unsupportedCommands` in `@shared/utils/dispatcher`). Replaces
// `isDesktopHost` checks for command-availability gating. `null` before
// that broadcast arrives — checked via `isKnownUnsupported`, which treats
// "not yet known" as unsupported so a control never flashes visible then
// hidden once the real capability set lands.
// ---------------------------------------------------------------------------
export const unsupportedCommands = signal<ReadonlySet<string> | null>(null);

// ---------------------------------------------------------------------------
// Reset — module-level state is shared across remounts in the same JS context
// (tests, hot reload). Mirrors `resetProgressState()` in progressState.ts.
// ---------------------------------------------------------------------------
export function resetSettingsState(): void {
  selectedTabIndex.set(0);

  memoryItems.set([]);
  memoryEnabled.set(false);
  memoryToggleDisabled.set(true);

  historyItems.set([]);

  authenticated.set(false);
  userEmail.set('');
  tier.set('free');
  apiAccessMode.set('personal');
  spendingStatus.set(null);
  quotaAutoSwitched.set(false);
  providerKeyStatuses.set([]);
  globalStreamingDefault.set(true);
  providerKeyModal.set(null);

  modelSelectionItems.set([]);
  helperModel.set(DEFAULT_HELPER_MODEL);
  preferShortModelNames.set(false);

  workflowAgents.set([]);
  toolUseAgents.set([]);
  customAgentDir.set('');
  customAgentDirIsDefault.set(true);
  agentSubTab.set(undefined);

  customPresets.set([]);
  orchestratorAgents.set([]);

  reliabilitySettings.set([]);
  allowOrchestratorKill.set(true);
  detachSubagentsOnStop.set(false);

  bashApprovalEnabled.set(true);
  codexSandboxMode.set('workspace-write');
  codexReasoningEffort.set('high');
  codexApprovalPolicy.set('never');
  claudeAgentModel.set(CLAUDE_AGENT_DEFAULT_MODEL);
  claudeAgentPermissionMode.set('acceptEdits');
  claudeAgentEffort.set('high');

  toolDashboardItems.set([]);
  toolDashboardLoaded.set(false);

  gitMarkCommits.set(DEFAULT_GIT_MARK_COMMITS);
  gitAuthorName.set(DEFAULT_GIT_AUTHOR_NAME);
  gitAuthorEmail.set(DEFAULT_GIT_AUTHOR_EMAIL);
  gitWorktreeSupport.set(false);
  gitSettingsLoaded.set(false);
  githubTokenStatus.set('none');
  chatgptAuth.set({ ...DEFAULT_CHATGPT_AUTH });
  desktopCrashReportingEnabled.set(false);
  desktopCrashReportingConfigured.set(false);
  prSubscriptions.set([]);

  latexSettingsStatus.set({ ...DEFAULT_LATEX_SETTINGS_STATUS });
  latexSettingsLoaded.set(false);
  latexConfigValues.set({});
  latexConfigValuesLoaded.set(false);
  inlineCriticismEnabled.set(false);

  goalItems.set([]);

  unsupportedCommands.set(null);
}
