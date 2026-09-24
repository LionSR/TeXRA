/**
 * Module-level reactive state for the Settings view.
 *
 * Each signal is an independent, flat piece of state, so the outbound handlers
 * import and set the ones they need directly rather than going through a
 * get/set context.
 *
 * SettingsApp has no persistence/restore path: every signal here is written
 * only by the `settingsViewHandlers` registry (see `messageDispatcher.ts`)
 * in response to backend SETTINGS_VIEW_COMMANDS messages — the
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

import { createTrackedSignalRegistry, Signal } from '@shared/signals';
import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  AGENT_SKILLS_CONFIG_KEY,
  BASH_APPROVAL_CONFIG_KEY,
  byCategory,
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING,
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  MODEL_COMPACTION_THRESHOLD_SETTING,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  TELEMETRY_ENABLED_KEY,
  TOOL_EDIT_APPROVAL_CONFIG_KEY,
  type AgentCategory,
  type AgentModePreset,
  type ByCategory,
  type InstalledPlugin,
  type SkillDisplayIssue,
  type SkillDisplayItem,
  type SubscriptionUsageSnapshots,
} from '@shared/schemas';
import { settingsViewSettingByKey } from '@shared/state/stateSettings';
import {
  DEFAULT_LATEX_SETTINGS_STATUS,
  type AgentScanIssue,
  type AgentSelectionItem,
  type CopilotRouteInfo,
  type MemoryViewItem,
  type ModelSelectionItem,
  type ProviderKeyStatus,
  type PRSubscriptionEntry,
  type SettingsTabPanelName,
  type SubscriptionAuthStatuses,
  type ToolDashboardItem,
} from '@shared/settingsView/settingsViewMessages';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';

// ---------------------------------------------------------------------------
// Reset registry — populated by `trackedSignal` as each signal below is
// declared.
// ---------------------------------------------------------------------------

const { trackedSignal, resetAll: resetTrackedSignals } =
  createTrackedSignalRegistry();

// ---------------------------------------------------------------------------
// Catalog-backed signals
// ---------------------------------------------------------------------------

/** Every catalog-backed signal created so far, keyed by canonical `texra.*` key. */
const CATALOG_SIGNALS = new Map<string, Signal.State<unknown>>();

/**
 * The signal for one settings catalog row, created on first use and the same
 * signal on every later call.
 *
 * The row already owns the default (`schema.parse(undefined)` yields its
 * `.prefault()`), so a declaration here restates neither the default nor the
 * wire field name; it names the key and the value type the tabs render. Being
 * keyed is what lets {@link applySettingsSnapshot} apply a whole
 * catalog-derived snapshot without a per-setting `.set()` line in a slice, and
 * lets a tab render rows it only knows by key (a tool card's inline settings).
 *
 * Throws on a key with no settings-view catalog row: a signal that no snapshot
 * can ever reach would silently render its default forever.
 */
export function settingSignal<T>(key: string): Signal.State<T> {
  const existing = CATALOG_SIGNALS.get(key);
  if (existing) return existing as Signal.State<T>;
  const entry = settingsViewSettingByKey(key);
  if (!entry) {
    throw new Error(`No settings-view catalog row for setting "${key}"`);
  }
  const state = trackedSignal<T>(() => entry.schema.parse(undefined) as T);
  CATALOG_SIGNALS.set(key, state as Signal.State<unknown>);
  return state;
}

/**
 * Apply a catalog-derived settings snapshot. Every key in the payload comes
 * from the catalog and was validated by its own row's schema at the message
 * boundary, so this is a direct fan-out to each key's signal (created here
 * when no tab has read it yet).
 */
export function applySettingsSnapshot(
  values: Readonly<Record<string, unknown>>,
): void {
  for (const [key, value] of Object.entries(values)) {
    settingSignal<unknown>(key).set(value);
  }
}

// ---------------------------------------------------------------------------
// Tab state
// ---------------------------------------------------------------------------
/**
 * Opening panel when the host asks for the settings view without naming a tab:
 * Models, the first page, because connecting a model is the first job.
 */
export const selectedPanel = trackedSignal<SettingsTabPanelName>(
  () => 'models',
);

// ---------------------------------------------------------------------------
// Memory state
// ---------------------------------------------------------------------------
export const memoryItems = trackedSignal<MemoryViewItem[]>(() => []);
export const memoryEnabled = settingSignal<boolean>(
  GlobalStateKey.MEMORY_ENABLED,
);

// ---------------------------------------------------------------------------
// Profile state
// ---------------------------------------------------------------------------
export const authenticated = trackedSignal(() => false);
export const userEmail = trackedSignal(() => '');
export const sessionProblem = trackedSignal<'expired' | 'unavailable' | null>(
  () => null,
);
export const providerKeyStatuses = trackedSignal<ProviderKeyStatus[]>(() => []);
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
export const customAgentScanIssues = trackedSignal<AgentScanIssue[]>(() => []);
export const agentSubTab = trackedSignal<AgentCategory | undefined>(
  () => undefined,
);

// ---------------------------------------------------------------------------
// Agent teams state
// ---------------------------------------------------------------------------
export const customPresets = trackedSignal<AgentModePreset[]>(() => []);
export const orchestratorAgents = trackedSignal<string[]>(() => []);
/** Team the workspace roster resolves to; null when the roster runs no team. */
export const activePresetId = trackedSignal<string | null>(() => null);

// ---------------------------------------------------------------------------
// Multi-agent coordination state
// ---------------------------------------------------------------------------
export const compactionThresholdPercent = settingSignal<number>(
  MODEL_COMPACTION_THRESHOLD_SETTING.configKey,
);
export const chatgptCodexContextWindow = settingSignal<number>(
  CHATGPT_CODEX_CONTEXT_WINDOW_SETTING.configKey,
);
export const modelRetryMaxAttempts = settingSignal<number>(
  MODEL_RETRY_MAX_ATTEMPTS_SETTING.configKey,
);
export const allowOrchestratorKill = settingSignal<boolean>(
  GlobalStateKey.ALLOW_ORCHESTRATOR_KILL,
);
export const detachSubagentsOnStop = settingSignal<boolean>(
  GlobalStateKey.DETACH_SUBAGENTS_ON_STOP,
);
export const childRunConcurrencyBudget = settingSignal<number>(
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
);
/**
 * Monotonic acknowledgement generation for the multi-agent payload. Incremented
 * on every outbound multi-agent settings message — including a rebroadcast that
 * carries the same values after a rejected/failed write — so SettingsApp
 * re-renders the Multi-Agent branch and `live()` can restore the acknowledged
 * committed value on the number input.
 */
export const multiAgentSettingsRevision = trackedSignal<number>(() => 0);

// ---------------------------------------------------------------------------
// Approval and tool-safety settings state
// ---------------------------------------------------------------------------
export const bashApprovalEnabled = settingSignal<boolean>(
  BASH_APPROVAL_CONFIG_KEY,
);
export const editApprovalEnabled = settingSignal<boolean>(
  TOOL_EDIT_APPROVAL_CONFIG_KEY,
);
export const approvalPolicy = settingSignal<TexraApprovalPolicy>(
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
);
export const toolPathProtectionEnabled = settingSignal<boolean>(
  WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
);
export const agentSkillsEnabled = settingSignal<boolean>(
  AGENT_SKILLS_CONFIG_KEY,
);
export const disabledSkills = settingSignal<string[]>(
  WorkspaceStateKey.DISABLED_SKILLS,
);
export const disabledSkillSources = settingSignal<string[]>(
  WorkspaceStateKey.DISABLED_SKILL_SOURCES,
);
export const installedPlugins = settingSignal<InstalledPlugin[]>(
  GlobalStateKey.INSTALLED_PLUGINS,
);
export const skillsList = trackedSignal<SkillDisplayItem[]>(() => []);
export const skillLoadIssues = trackedSignal<SkillDisplayIssue[]>(() => []);
export const telemetryEnabled = settingSignal<boolean>(TELEMETRY_ENABLED_KEY);

// ---------------------------------------------------------------------------
// Tool dashboard state
// ---------------------------------------------------------------------------
export const toolDashboardItems = trackedSignal<ToolDashboardItem[]>(() => []);
export const toolDashboardLoaded = trackedSignal(() => false);

// ---------------------------------------------------------------------------
// Git author settings state
// ---------------------------------------------------------------------------
export const gitMarkCommits = settingSignal<boolean>(
  WorkspaceStateKey.GIT_MARK_COMMITS,
);
export const gitAuthorName = settingSignal<string>(
  WorkspaceStateKey.GIT_AUTHOR_NAME,
);
export const gitAuthorEmail = settingSignal<string>(
  WorkspaceStateKey.GIT_AUTHOR_EMAIL,
);
export const gitWorktreeSupport = settingSignal<boolean>(
  WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
);
export const gitSettingsLoaded = trackedSignal(() => false);
export const githubTokenStatus = trackedSignal<'secret' | 'env' | 'none'>(
  () => 'none',
);
/**
 * Sign-in status per subscription provider, addressed by the same provider id
 * the payload carries. A provider missing from the record has not reported
 * yet; the section renders its signed-out row until it does.
 */
export const subscriptionAuth = trackedSignal<SubscriptionAuthStatuses>(
  () => ({}),
);
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
export const workflowAutoCompile = settingSignal<boolean>(
  WorkspaceStateKey.WORKFLOW_AUTO_COMPILE,
);
export const workflowAutoOpenPdf = settingSignal<boolean>(
  WorkspaceStateKey.WORKFLOW_AUTO_OPEN_PDF,
);
export const workflowRejectOnCompileFailure = settingSignal<boolean>(
  WorkspaceStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
);
export const latexdiffBetweenRounds = settingSignal<boolean>(
  WorkspaceStateKey.LATEXDIFF_BETWEEN_ROUNDS,
);
export const latexdiffChangesOnly = settingSignal<boolean>(
  WorkspaceStateKey.LATEXDIFF_CHANGES_ONLY,
);
export const latexdiffMathMarkup = settingSignal<string>(
  WorkspaceStateKey.LATEXDIFF_MATH_MARKUP,
);
export const latexFormatter = settingSignal<string>(
  WorkspaceStateKey.LATEX_FORMATTER,
);
export const inlineCriticismEnabled = settingSignal<boolean>(
  GlobalStateKey.INLINE_CRITICISM_ENABLED,
);

// ---------------------------------------------------------------------------
// Reset — module-level state is shared across remounts in the same JS context
// (tests, hot reload), so a fresh mount replays every registered default.
// ---------------------------------------------------------------------------
export function resetSettingsState(): void {
  resetTrackedSignals();
}
