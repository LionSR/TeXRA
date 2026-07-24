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
 *
 * Reset mechanism: every writable signal below is declared through
 * `trackedSignal()` instead of the bare `signal()` import. `trackedSignal`
 * records the signal's own default-value factory in `resetCallbacks` at the
 * point of declaration, so `resetSettingsState()` can replay that single list
 * instead of a hand-written, independently-ordered sequence of `.set()`
 * calls. There is only one place that knows each signal's default — the
 * `trackedSignal(() => ...)` call site — so a new signal can't be added
 * without also being wired into the reset; forgetting the wrapper here would
 * mean the signal isn't exported as reactive state at all.
 */

import { createTrackedSignalRegistry } from '@shared/signals';
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
import type { ApiAccessMode } from '@shared/schemas/modelAccess';
import {
  DEFAULT_GIT_AUTHOR_NAME,
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_MARK_COMMITS,
} from '@shared/schemas/stateSettings';
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
// Reset registry — populated by `trackedSignal` as each signal below is
// declared. See the file-header note on the reset mechanism.
// ---------------------------------------------------------------------------

const { trackedSignal, resetAll: resetTrackedSignals } =
  createTrackedSignalRegistry();

// ---------------------------------------------------------------------------
// Tab state
// ---------------------------------------------------------------------------
export const selectedTabIndex = trackedSignal(() => 0);

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
export const apiAccessMode = trackedSignal<ApiAccessMode>(() => 'personal');
export const spendingStatus = trackedSignal<SpendingStatus | null>(() => null);
export const quotaAutoSwitched = trackedSignal(() => false);
export const providerKeyStatuses = trackedSignal<ProviderKeyStatus[]>(() => []);
export const globalStreamingDefault = trackedSignal(() => true);
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

// ---------------------------------------------------------------------------
// Agent selection state
// ---------------------------------------------------------------------------
export const workflowAgents = trackedSignal<AgentSelectionItem[]>(() => []);
export const toolUseAgents = trackedSignal<AgentSelectionItem[]>(() => []);
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
export const reliabilitySettings = trackedSignal<NumberVscodeSetting[]>(
  () => [],
);
export const allowOrchestratorKill = trackedSignal(() => true);
export const detachSubagentsOnStop = trackedSignal(() => false);

// ---------------------------------------------------------------------------
// Approval settings state
// ---------------------------------------------------------------------------
export const bashApprovalEnabled = trackedSignal(() => true);
export const agentSkillsEnabled = trackedSignal(() => true);
export const codexSandboxMode = trackedSignal<string>(() => 'workspace-write');
export const codexReasoningEffort = trackedSignal<string>(() => 'high');
export const codexApprovalPolicy = trackedSignal<string>(() => 'never');
export const claudeAgentModel = trackedSignal<ClaudeAgentModel>(
  () => CLAUDE_AGENT_DEFAULT_MODEL,
);
export const claudeAgentPermissionMode =
  trackedSignal<ClaudeAgentPermissionMode>(() => 'acceptEdits');
export const claudeAgentEffort = trackedSignal<ClaudeAgentEffort>(() => 'high');

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
export const gitWorktreeSupport = trackedSignal(() => false);
export const gitSettingsLoaded = trackedSignal(() => false);
export const githubTokenStatus = trackedSignal<'secret' | 'env' | 'none'>(
  () => 'none',
);
export const chatgptAuth = trackedSignal<ChatGptAuthStatus>(() => ({
  ...DEFAULT_CHATGPT_AUTH,
}));
export const desktopCrashReportingEnabled = trackedSignal(() => false);
export const desktopCrashReportingConfigured = trackedSignal(() => false);
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
// (tests, hot reload). Mirrors `resetProgressState()` in progressState.ts in
// intent (replay the one source of truth on remount); the mechanism differs
// because these signals stay individually exported rather than living behind
// one monolithic object signal — see the file-header note.
// ---------------------------------------------------------------------------
export function resetSettingsState(): void {
  resetTrackedSignals();
}
