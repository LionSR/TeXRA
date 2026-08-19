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

import { createTrackedSignalRegistry, Signal } from '@shared/signals';
import {
  TEXRA_APPROVAL_POLICY_CONFIG_KEY,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  AGENT_SKILLS_CONFIG_KEY,
  BASH_APPROVAL_CONFIG_KEY,
  byCategory,
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  DEFAULT_GLOBAL_STREAMING,
  DEFAULT_LATEX_SETTINGS_STATUS,
  SETTINGS_TAB_PANEL_BY_NAME,
  settingsViewSettingByKey,
  TELEMETRY_ENABLED_KEY,
  TOOL_EDIT_APPROVAL_CONFIG_KEY,
  type AgentCategory,
  type AgentModePreset,
  type AgentScanIssue,
  type AgentSelectionItem,
  type ByCategory,
  type ChatGptAuthStatus,
  type ClaudeAgentEffort,
  type ClaudeAgentModel,
  type ClaudeAgentPermissionMode,
  type CodexApprovalPolicy,
  type CodexReasoningEffort,
  type CodexSandboxMode,
  type CopilotRouteInfo,
  type Goal,
  type GrokAuthStatus,
  type LatexConfigValues,
  type MemoryViewItem,
  type ModelSelectionItem,
  type NumberSetting,
  type ProviderKeyStatus,
  type PRSubscriptionEntry,
  type SubscriptionUsageSnapshots,
  type ToolDashboardItem,
} from '@shared/schemas';
import type { SettingsTabPanelName } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';

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
// Catalog-backed signals
// ---------------------------------------------------------------------------

/** Setters for every catalog-backed signal, keyed by canonical `texra.*` key. */
const CATALOG_SIGNAL_SETTERS = new Map<string, (value: unknown) => void>();

/**
 * Declare the signal for one settings catalog row.
 *
 * The row already owns the default (`schema.parse(undefined)` yields its
 * `.prefault()`), so a declaration here restates neither the default nor the
 * wire field name; it names the key and the value type the tabs render. It also
 * registers the setter under that key, which is what lets
 * {@link applySettingsSnapshot} apply a whole catalog-derived snapshot without
 * a per-setting `.set()` line in a slice.
 *
 * Throws on a key with no settings-view catalog row: a signal that no snapshot
 * can ever reach would silently render its default forever.
 */
function settingSignal<T>(key: string): Signal.State<T> {
  const entry = settingsViewSettingByKey(key);
  if (!entry) {
    throw new Error(`No settings-view catalog row for setting "${key}"`);
  }
  const state = trackedSignal<T>(() => entry.schema.parse(undefined) as T);
  // Sound because the snapshot arm validated the value with this same row's
  // schema before it reached the frontend.
  CATALOG_SIGNAL_SETTERS.set(key, (value) => state.set(value as T));
  return state;
}

/**
 * Apply a catalog-derived settings snapshot. Every key in the payload comes
 * from the catalog and was validated by its own row's schema at the message
 * boundary, so this is a direct fan-out to the declared signals. A key with no
 * declared signal means a row joined a snapshot without a signal to render it
 * — reported, never swallowed.
 */
export function applySettingsSnapshot(
  values: Readonly<Record<string, unknown>>,
): void {
  for (const [key, value] of Object.entries(values)) {
    const setter = CATALOG_SIGNAL_SETTERS.get(key);
    if (!setter) {
      console.warn(
        `[settings] No signal declared for catalog setting "${key}"; the settings view cannot render it.`,
      );
      continue;
    }
    setter(value);
  }
}

// ---------------------------------------------------------------------------
// Tab state
// ---------------------------------------------------------------------------
/**
 * Opening panel when the host asks for the settings view without naming a tab.
 * Account is the first nav group, so this matches what the nav already
 * presents as the entry point.
 */
export const selectedPanel = trackedSignal<SettingsTabPanelName>(
  () => SETTINGS_TAB_PANEL_BY_NAME.ACCOUNT,
);

// ---------------------------------------------------------------------------
// Memory state
// ---------------------------------------------------------------------------
export const memoryItems = trackedSignal<MemoryViewItem[]>(() => []);
export const memoryEnabled = trackedSignal(() => false);
export const memoryToggleDisabled = trackedSignal(() => true);

// ---------------------------------------------------------------------------
// Profile state
// ---------------------------------------------------------------------------
export const authenticated = trackedSignal(() => false);
export const userEmail = trackedSignal(() => '');
export const sessionProblem = trackedSignal<'expired' | 'unavailable' | null>(
  () => null,
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
export const customAgentScanIssues = trackedSignal<AgentScanIssue[]>(() => []);
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
export const allowOrchestratorKill = settingSignal<boolean>(
  WorkspaceStateKey.ALLOW_ORCHESTRATOR_KILL,
);
export const detachSubagentsOnStop = settingSignal<boolean>(
  WorkspaceStateKey.DETACH_SUBAGENTS_ON_STOP,
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
export const telemetryEnabled = settingSignal<boolean>(TELEMETRY_ENABLED_KEY);
export const codexSandboxMode = settingSignal<CodexSandboxMode>(
  WorkspaceStateKey.CODEX_SANDBOX_MODE,
);
export const codexReasoningEffort = settingSignal<CodexReasoningEffort>(
  WorkspaceStateKey.CODEX_REASONING_EFFORT,
);
export const codexApprovalPolicy = settingSignal<CodexApprovalPolicy>(
  WorkspaceStateKey.CODEX_APPROVAL_POLICY,
);
export const claudeAgentModel = settingSignal<ClaudeAgentModel>(
  WorkspaceStateKey.CLAUDE_AGENT_MODEL,
);
export const claudeAgentPermissionMode =
  settingSignal<ClaudeAgentPermissionMode>(
    WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
  );
export const claudeAgentEffort = settingSignal<ClaudeAgentEffort>(
  WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
);

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
