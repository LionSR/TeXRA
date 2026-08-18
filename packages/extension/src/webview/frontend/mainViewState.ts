/**
 * Module-level reactive state for the Main view.
 *
 * Hoisted from `MainApp` private `signal(...)` fields, following the same
 * module-scope slice-store shape as `progressView/frontend/progressState.ts`.
 * Identity and reactivity are preserved: consumers still read plain signals
 * and `Signal.Computed` derivations, and `MainApp` keeps its
 * `@provide`/`@state` + `willUpdate()` context-sync idiom — only what feeds
 * `fileStateContext$`/`sessionContext$` moved from `this.xxx` fields to these
 * module-scope signals.
 *
 * Singleton scope: only one Main view per webview/page. If we ever need
 * multiple independent main-view instances on the same page, this file must
 * be promoted to a per-instance store.
 *
 * Reset mechanism: every writable signal below is declared through
 * `trackedSignal()` instead of the bare `signal()` import. `trackedSignal`
 * records the signal's own default-value factory in `resetCallbacks` at the
 * point of declaration, so `resetMainViewState()` can replay that single list
 * instead of a hand-written, independently-ordered sequence of `.set()`
 * calls. There is only one place that knows each signal's default — the
 * `trackedSignal(() => ...)` call site — so a new signal can't be added
 * without also being wired into the reset.
 */

// Local imports - shared signals and schemas
import { Signal, createTrackedSignalRegistry } from '@shared/signals';
import type {
  AgentConfigBannerState,
  AgentOptionData,
  ApiKeyBannerState,
  CheckboxValues,
  DependencyBannerState,
  FileOptions,
  LaunchTarget,
  ModelOptionData,
  MultiFiles,
  OnboardingFunnelState,
  SingleFiles,
  TeamOptionData,
  WorkspaceRootOptionData,
} from '@shared/schemas';
import { byCategory, type ByCategory } from '@shared/schemas';

// Local imports - main view
import { SESSION_TYPES, type SessionType } from './constants';
import {
  DEFAULT_CHECKBOX_VALUES,
  DEFAULT_FILE_OPTIONS,
  DEFAULT_MULTI_FILES,
  DEFAULT_SINGLE_FILES,
  DEFAULT_STATE,
  ONBOARDING_PLACEHOLDERS,
} from './store';
import type {
  FileStateContextValue,
  SessionContextValue,
} from './mainViewContexts';

/** Onboarding funnel plus the pre-first-push sentinel. */
type WebviewOnboardingFunnelState = OnboardingFunnelState | 'pending';

// ---------------------------------------------------------------------------
// Reset registry — populated by `trackedSignal` as each signal below is
// declared. See the file-header note on the reset mechanism.
// ---------------------------------------------------------------------------

const { trackedSignal, resetAll: resetTrackedSignals } =
  createTrackedSignalRegistry();

// ---------------------------------------------------------------------------
// Session / agent / model / instruction state
// ---------------------------------------------------------------------------

export const sessionType$ = trackedSignal<SessionType>(
  () => DEFAULT_STATE.sessionType,
);
export const launchTarget$ = trackedSignal<LaunchTarget>(
  () => DEFAULT_STATE.launchTarget,
);
export const selectedTeamId$ = trackedSignal(
  () => DEFAULT_STATE.selectedTeamId,
);
export const workingDirectory$ = trackedSignal(
  () => DEFAULT_STATE.workingDirectory,
);
export const agent$ = trackedSignal<ByCategory<string>>(() => ({
  ...DEFAULT_STATE.agent,
}));
export const model$ = trackedSignal(() => DEFAULT_STATE.model);
export const commit$ = trackedSignal(() => DEFAULT_STATE.commit);
export const instructionDrafts$ = trackedSignal<ByCategory<string>>(() => ({
  ...DEFAULT_STATE.instruction,
}));

/**
 * The draft of the active session mode. Derived, not stored: the per-mode
 * drafts above are the only writable instruction state, so switching modes
 * cannot leave the visible draft out of sync with the mode it belongs to.
 */
export const instruction$ = new Signal.Computed(
  (): string => instructionDrafts$.get()[sessionType$.get()],
);
export const instructionPlaceholder$ = trackedSignal(
  () => ONBOARDING_PLACEHOLDERS[DEFAULT_STATE.sessionType][0],
);

// ---------------------------------------------------------------------------
// Document / file state
// ---------------------------------------------------------------------------

export const singleFiles$ = trackedSignal<SingleFiles>(() => ({
  ...DEFAULT_SINGLE_FILES,
}));
export const fileOptions$ = trackedSignal<FileOptions>(() => ({
  ...DEFAULT_FILE_OPTIONS,
}));
export const multiFiles$ = trackedSignal<MultiFiles>(() => ({
  ...DEFAULT_MULTI_FILES,
}));
export const checkboxValues$ = trackedSignal<CheckboxValues>(() => ({
  ...DEFAULT_CHECKBOX_VALUES,
}));
export const isGitRepo$ = trackedSignal(() => true);

// ---------------------------------------------------------------------------
// LaTeX-diffs UI state
// ---------------------------------------------------------------------------

export const latexdiffsVisible$ = trackedSignal(
  () => DEFAULT_STATE.latexdiffsVisible,
);

// ---------------------------------------------------------------------------
// Model / agent catalog data
// ---------------------------------------------------------------------------

export const sessionModelOptions$ = trackedSignal<
  ByCategory<ModelOptionData[]>
>(() => byCategory(() => []));
export const agentOptions$ = trackedSignal<ByCategory<AgentOptionData[]>>(() =>
  byCategory(() => []),
);
export const teamOptions$ = trackedSignal<TeamOptionData[]>(() => []);
export const workspaceRootOptions$ = trackedSignal<WorkspaceRootOptionData[]>(
  () => [],
);

// ---------------------------------------------------------------------------
// Chat / voice state
// ---------------------------------------------------------------------------

export const isRecording$ = trackedSignal(() => false);
export const isPolishing$ = trackedSignal(() => false);

/**
 * Last status line pushed to the InstructionPanel's visually-hidden aria-live
 * region (screen-reader announcements for launcher/target fallbacks). Not
 * persisted; cleared on remount.
 */
export const statusAnnouncement$ = trackedSignal(() => '');

// ---------------------------------------------------------------------------
// Banners / onboarding state
// ---------------------------------------------------------------------------

export const apiKeyBanner$ = trackedSignal<ApiKeyBannerState>(() => ({
  visible: false,
}));
export const agentConfigBanner$ = trackedSignal<AgentConfigBannerState>(() => ({
  visible: false,
}));
export const dependencyBanner$ = trackedSignal<DependencyBannerState>(() => ({
  visible: false,
}));
export const gettingStartedVisible$ = trackedSignal(() => false);
// Session-only: the host re-sends the getting-started SET_BANNER on file
// refreshes, so dismissal is tracked separately and never persisted.
export const gettingStartedDismissed$ = trackedSignal(() => false);
export const sessionHintDismissed$ = trackedSignal(() => true);
export const loginBannerVisible$ = trackedSignal(() => false);
// Onboarding funnel (PRD: agent-native onboarding). The host owns the real
// state; 'pending' only suppresses first-paint launcher/welcome flashes until
// SET_ONBOARDING_FUNNEL arrives.
export const onboardingFunnelState$ =
  trackedSignal<WebviewOnboardingFunnelState>(() => 'pending');

// ---------------------------------------------------------------------------
// Host-pushed debug flag (mirrored from MainApp's @state field in willUpdate
// so the module-scope sessionContext$ derivation can observe it).
// ---------------------------------------------------------------------------

export const debugMode$ = trackedSignal(() => false);

// ---------------------------------------------------------------------------
// Derived read helpers
// ---------------------------------------------------------------------------

export function getModelOptionsForSession(
  sessionType: SessionType,
): ModelOptionData[] {
  return sessionModelOptions$.get()[sessionType];
}

export function primaryInputFile(): string {
  return multiFiles$.get().inputFiles[0] ?? '';
}

/**
 * Whether the currently selected tool-use agent is an orchestrator. Computed
 * once here so `refreshInstructionPlaceholder` (placeholder copy) and
 * `InstructionPanel`'s session hint (hint copy) can't derive divergent
 * answers to the same question.
 */
export const isSelectedAgentOrchestrator$ = new Signal.Computed((): boolean => {
  if (sessionType$.get() !== SESSION_TYPES.TOOL_USE) return false;
  const agentId = agent$.get().toolUse;
  const opt = agentOptions$.get().toolUse.find((o) => o.value === agentId);
  return opt?.isOrchestrator ?? false;
});

// ---------------------------------------------------------------------------
// Context derivations consumed by MainApp's @provide/@state fields
// ---------------------------------------------------------------------------

export const fileStateContext$ = new Signal.Computed(
  (): FileStateContextValue => ({
    sessionType: sessionType$.get(),
    checkboxValues: checkboxValues$.get(),
    singleFiles: singleFiles$.get(),
    fileOptions: fileOptions$.get(),
    multiFiles: multiFiles$.get(),
  }),
);

export const sessionContext$ = new Signal.Computed((): SessionContextValue => ({
  sessionType: sessionType$.get(),
  launchTarget: launchTarget$.get(),
  selectedTeamId: selectedTeamId$.get(),
  instruction: instruction$.get(),
  placeholder: instructionPlaceholder$.get(),
  agent: agent$.get(),
  model: model$.get(),
  agentOptions: agentOptions$.get(),
  modelOptions: getModelOptionsForSession(sessionType$.get()),
  teamOptions: teamOptions$.get(),
  workspaceRootOptions: workspaceRootOptions$.get(),
  workingDirectory: workingDirectory$.get(),
  isRecording: isRecording$.get(),
  isPolishing: isPolishing$.get(),
  debugMode: debugMode$.get(),
  isOrchestratorSelected: isSelectedAgentOrchestrator$.get(),
  statusAnnouncement: statusAnnouncement$.get(),
}));

/**
 * Reset every writable signal to its initial value. Called from `MainApp`'s
 * constructor on remount in the same JS context (tests, hot reload) so each
 * mount starts from the same slate a fresh per-instance field set used to
 * provide. Main-view state is singleton-scoped per the file header, so the
 * reset is a per-mount slate, not multi-instance coordination.
 *
 * Replays the tracked-signal registry populated by `trackedSignal` at each
 * signal's declaration site above — see the file-header note on the reset
 * mechanism.
 */
export function resetMainViewState(): void {
  resetTrackedSignals();
}
