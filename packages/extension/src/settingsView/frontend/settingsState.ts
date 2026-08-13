/**
 * Module-level reactive state for the Settings view.
 *
 * Each signal is an independent, flat piece of state, so slices import and set
 * the ones they need directly rather than going through a get/set context.
 *
 * SettingsApp has no persistence/restore path: every signal here is written
 * only by the composed `messageHandlers` registry (see `messageDispatcher.ts`
 * + `slices/`) in response to backend SETTINGS_VIEW_COMMANDS messages — the
 * backend configuration is the actual source of truth, this file is a pure
 * receiver.
 *
 * Singleton scope: only one Settings view per webview/page. If we ever need
 * multiple independent settings instances on the same page, this file must be
 * promoted to a per-instance store.
 *
 * Declare writable signals with `trackedSignal()` rather than the bare
 * `signal()`: the registry records each default-value factory at its
 * declaration site, and that single list is what `resetSettingsState()`
 * replays. A signal declared any other way is silently left out of the reset.
 */

import { createTrackedSignalRegistry } from '@shared/signals';
import {
  TEXRA_APPROVAL_POLICY_DEFAULT,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  byCategory,
  DEFAULT_GLOBAL_STREAMING,
  DEFAULT_QUOTA_AUTO_SWITCHED,
  SETTINGS_TAB,
  type AgentCategory,
  type ByCategory,
  type HistoryItem,
  type MemoryViewItem,
  type ModelSelectionItem,
  type ProviderKeyStatus,
  type SpendingStatus,
  type SpendingStatusError,
  type SubscriptionUsageSnapshots,
} from '@shared/schemas';
import {
  type AgentSelectionItem,
  type ClaudeAgentEffort,
  type ClaudeAgentModel,
  type ClaudeAgentPermissionMode,
  type CodexApprovalPolicy,
  type CodexReasoningEffort,
  type CodexSandboxMode,
  type LatexConfigValues,
  type NumberSetting,
  type Goal,
  type PRSubscriptionEntry,
  type ToolDashboardItem,
  type ChatGptAuthStatus,
  type GrokAuthStatus,
  type CopilotRouteInfo,
  DEFAULT_LATEX_SETTINGS_STATUS,
} from '@shared/schemas/settingsViewMessages';
import {
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_MARK_COMMITS,
  DEFAULT_GIT_WORKTREE_SUPPORT,
  DEFAULT_TOOL_PATH_PROTECTION_ENABLED,
} from '@shared/schemas/stateSettings';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import { AGENT_SKILLS_ENABLED_DEFAULT } from '@shared/schemas/agentSkills';
import type { AgentModePreset } from '@shared/schemas/agentPresets';
import {
  CLAUDE_AGENT_DEFAULT_EFFORT,
  CLAUDE_AGENT_DEFAULT_MODEL,
  CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
  CODEX_APPROVAL_POLICY_DEFAULT,
  CODEX_REASONING_EFFORT_DEFAULT,
  CODEX_SANDBOX_MODE_DEFAULT,
} from '@shared/schemas/agentCliSettings';

/** Target for the desktop-host "set provider key" modal. */
interface ProviderKeyModalTarget {
  provider: string;
  displayName: string;
}

const DEFAULT_CHATGPT_AUTH: ChatGptAuthStatus = {
  signedIn: false,
  preferSubscription: false,
};

const DEFAULT_GROK_AUTH: GrokAuthStatus = {
  signedIn: false,
  preferSubscription: false,
};

// ---------------------------------------------------------------------------
// Reset registry — populated by `trackedSignal` as each signal below is
// declared.
// ---------------------------------------------------------------------------

const { trackedSignal, resetAll: resetTrackedSignals } =
  createTrackedSignalRegistry();

// ---------------------------------------------------------------------------
// Tab state
// ---------------------------------------------------------------------------
/**
 * Opening panel when the host asks for the settings view without naming a tab.
 *
 * Named, not `0`: SETTINGS_TAB_ORDER is an append-only wire format, so index 0
 * means whichever panel happened to be added first (MEMORY) rather than
 * anything intended. Account is also the first nav group, so this matches what
 * the nav already presents as the entry point.
 */
export const selectedTabIndex = trackedSignal<number>(
  () => SETTINGS_TAB.ACCOUNT,
);

// ---------------------------------------------------------------------------
// Memory state
// ---------------------------------------------------------------------------
export const memoryItems = trackedSignal<MemoryViewItem[]>(() => []);
export const memoryEnabled = trackedSignal(() => false);
export const memoryToggleDisabled = trackedSignal(() => true);

// ---------------------------------------------------------------------------
// History state
// ---------------------------------------------------------------------------
export const historyItems = trackedSignal<HistoryItem[]>(() => []);

// ---------------------------------------------------------------------------
// Profile state
// ---------------------------------------------------------------------------
export const authenticated = trackedSignal(() => false);
export const userEmail = trackedSignal(() => '');
export const tier = trackedSignal(() => 'free');
export const apiAccessMode = trackedSignal<'included' | 'personal'>(
  () => 'personal',
);
export const sessionProblem = trackedSignal<'expired' | 'unavailable' | null>(
  () => null,
);
export const spendingStatus = trackedSignal<SpendingStatus | null>(() => null);
export const spendingStatusError = trackedSignal<SpendingStatusError | null>(
  () => null,
);
export const quotaAutoSwitched = trackedSignal(
  () => DEFAULT_QUOTA_AUTO_SWITCHED,
);
export const providerKeyStatuses = trackedSignal<ProviderKeyStatus[]>(() => []);
export const globalStreamingDefault = trackedSignal(
  () => DEFAULT_GLOBAL_STREAMING,
);
export const providerKeyModal = trackedSignal<ProviderKeyModalTarget | null>(
  () => null,
);

// ---------------------------------------------------------------------------
// Model selection state
// ---------------------------------------------------------------------------
export const modelSelectionItems = trackedSignal<ModelSelectionItem[]>(
  () => [],
);
export const helperModel = trackedSignal(() => DEFAULT_HELPER_MODEL);
export const preferShortModelNames = trackedSignal(() => false);
export const copilotRouteInfos = trackedSignal<CopilotRouteInfo[]>(() => []);

// ---------------------------------------------------------------------------
// Agent selection state
// ---------------------------------------------------------------------------
export const agentSelectionItems = trackedSignal<
  ByCategory<AgentSelectionItem[]>
>(() => byCategory(() => []));
export const customAgentDir = trackedSignal(() => '');
export const customAgentDirIsDefault = trackedSignal(() => true);
export const agentSubTab = trackedSignal<AgentCategory | undefined>(
  () => undefined,
);

// ---------------------------------------------------------------------------
// Agent teams state
// ---------------------------------------------------------------------------
export const customPresets = trackedSignal<AgentModePreset[]>(() => []);
export const orchestratorAgents = trackedSignal<string[]>(() => []);

// ---------------------------------------------------------------------------
// Multi-agent coordination state
// ---------------------------------------------------------------------------
export const reliabilitySettings = trackedSignal<NumberSetting[]>(() => []);
export const allowOrchestratorKill = trackedSignal(() => true);
export const detachSubagentsOnStop = trackedSignal(() => false);

// ---------------------------------------------------------------------------
// Approval and tool-safety settings state
// ---------------------------------------------------------------------------
export const bashApprovalEnabled = trackedSignal(() => true);
export const editApprovalEnabled = trackedSignal(() => true);
export const approvalPolicy = trackedSignal<TexraApprovalPolicy>(
  () => TEXRA_APPROVAL_POLICY_DEFAULT,
);
export const toolPathProtectionEnabled = trackedSignal(
  () => DEFAULT_TOOL_PATH_PROTECTION_ENABLED,
);
export const agentSkillsEnabled = trackedSignal(
  () => AGENT_SKILLS_ENABLED_DEFAULT,
);
export const telemetryEnabled = trackedSignal(() => true);
export const codexSandboxMode = trackedSignal<CodexSandboxMode>(
  () => CODEX_SANDBOX_MODE_DEFAULT,
);
export const codexReasoningEffort = trackedSignal<CodexReasoningEffort>(
  () => CODEX_REASONING_EFFORT_DEFAULT,
);
export const codexApprovalPolicy = trackedSignal<CodexApprovalPolicy>(
  () => CODEX_APPROVAL_POLICY_DEFAULT,
);
export const claudeAgentModel = trackedSignal<ClaudeAgentModel>(
  () => CLAUDE_AGENT_DEFAULT_MODEL,
);
export const claudeAgentPermissionMode =
  trackedSignal<ClaudeAgentPermissionMode>(
    () => CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
  );
export const claudeAgentEffort = trackedSignal<ClaudeAgentEffort>(
  () => CLAUDE_AGENT_DEFAULT_EFFORT,
);

// ---------------------------------------------------------------------------
// Tool dashboard state
// ---------------------------------------------------------------------------
export const toolDashboardItems = trackedSignal<ToolDashboardItem[]>(() => []);
export const toolDashboardLoaded = trackedSignal(() => false);

// ---------------------------------------------------------------------------
// Git author settings state
// ---------------------------------------------------------------------------
export const gitMarkCommits = trackedSignal(() => DEFAULT_GIT_MARK_COMMITS);
export const gitAuthorName = trackedSignal(() => DEFAULT_GIT_AUTHOR_NAME);
export const gitAuthorEmail = trackedSignal(() => DEFAULT_GIT_AUTHOR_EMAIL);
export const gitWorktreeSupport = trackedSignal(
  () => DEFAULT_GIT_WORKTREE_SUPPORT,
);
export const gitSettingsLoaded = trackedSignal(() => false);
export const githubTokenStatus = trackedSignal<'secret' | 'env' | 'none'>(
  () => 'none',
);
export const chatgptAuth = trackedSignal<ChatGptAuthStatus>(() => ({
  ...DEFAULT_CHATGPT_AUTH,
}));
export const grokAuth = trackedSignal<GrokAuthStatus>(() => ({
  ...DEFAULT_GROK_AUTH,
}));
export const subscriptionUsage =
  trackedSignal<SubscriptionUsageSnapshots | null>(() => null);
export const prSubscriptions = trackedSignal<readonly PRSubscriptionEntry[]>(
  () => [],
);

// ---------------------------------------------------------------------------
// LaTeX settings state
// ---------------------------------------------------------------------------
export const latexSettingsStatus = trackedSignal(() => ({
  ...DEFAULT_LATEX_SETTINGS_STATUS,
}));
export const latexSettingsLoaded = trackedSignal(() => false);
export const latexConfigValues = trackedSignal<LatexConfigValues>(() => ({}));
export const latexConfigValuesLoaded = trackedSignal(() => false);
export const inlineCriticismEnabled = trackedSignal(() => false);

// ---------------------------------------------------------------------------
// Goal settings state
// ---------------------------------------------------------------------------
export const goalItems = trackedSignal<readonly Goal[]>(() => []);

// ---------------------------------------------------------------------------
// Derived capability view: commands the active host's inbound registry
// declares `unsupported(...)`, sent once at webview-ready (see
// `unsupportedCommands` in `@shared/utils/dispatcher`). Replaces
// `isDesktopHost` checks for command-availability gating. `null` before
// that broadcast arrives — checked via `isKnownUnsupported`, which treats
// "not yet known" as unsupported so a control never flashes visible then
// hidden once the real capability set lands.
// ---------------------------------------------------------------------------
export const unsupportedCommands = trackedSignal<ReadonlySet<string> | null>(
  () => null,
);

// ---------------------------------------------------------------------------
// Reset — module-level state is shared across remounts in the same JS context
// (tests, hot reload), so a fresh mount replays every registered default.
// ---------------------------------------------------------------------------
export function resetSettingsState(): void {
  resetTrackedSignals();
}
