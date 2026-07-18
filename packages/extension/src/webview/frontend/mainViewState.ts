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
 */

// Local imports - shared signals and schemas
import { Signal, signal } from '@shared/signals';
import type {
  AgentConfigBannerState,
  AgentOptionData,
  ApiKeyBannerState,
  CheckboxValues,
  DependencyBannerState,
  FileOptions,
  ModelOptionData,
  MultiFiles,
  OnboardingFunnelState,
  SingleFiles,
} from '@shared/schemas';

// Local imports - main view
import { SESSION_TYPES, type SessionType } from './constants';
import {
  fileStateContext,
  sessionContext,
  type FileStateContextValue,
  type SessionContextValue,
} from './contexts/mainViewContexts';
import {
  DEFAULT_CHECKBOX_VALUES,
  DEFAULT_FILE_OPTIONS,
  DEFAULT_MULTI_FILES,
  DEFAULT_SINGLE_FILES,
  DEFAULT_STATE,
  ONBOARDING_PLACEHOLDERS,
} from './store';

// Re-export the context objects so MainApp wires @provide from one place.
export { fileStateContext, sessionContext };
export type { FileStateContextValue, SessionContextValue };

/** Onboarding funnel plus the pre-first-push sentinel. */
export type WebviewOnboardingFunnelState = OnboardingFunnelState | 'pending';

// ---------------------------------------------------------------------------
// Session / agent / model / instruction state
// ---------------------------------------------------------------------------

export const sessionType$ = signal<SessionType>(DEFAULT_STATE.sessionType);
export const workflowAgent$ = signal(DEFAULT_STATE.workflowAgent);
export const toolUseAgent$ = signal(DEFAULT_STATE.toolUseAgent);
export const model$ = signal(DEFAULT_STATE.model);
export const commit$ = signal(DEFAULT_STATE.commit);
export const instruction$ = signal(DEFAULT_STATE.instruction);
export const workflowInstruction$ = signal(DEFAULT_STATE.workflowInstruction);
export const toolUseInstruction$ = signal(DEFAULT_STATE.toolUseInstruction);
export const instructionPlaceholder$ = signal(
  ONBOARDING_PLACEHOLDERS[DEFAULT_STATE.sessionType][0],
);

// ---------------------------------------------------------------------------
// Document / file state
// ---------------------------------------------------------------------------

export const singleFiles$ = signal<SingleFiles>({ ...DEFAULT_SINGLE_FILES });
export const fileOptions$ = signal<FileOptions>({ ...DEFAULT_FILE_OPTIONS });
export const multiFiles$ = signal<MultiFiles>({ ...DEFAULT_MULTI_FILES });
export const checkboxValues$ = signal<CheckboxValues>({
  ...DEFAULT_CHECKBOX_VALUES,
});
export const isGitRepo$ = signal(true);

// ---------------------------------------------------------------------------
// LaTeX-diffs / files-panel UI state
// ---------------------------------------------------------------------------

export const latexdiffsVisible$ = signal(DEFAULT_STATE.latexdiffsVisible);
/**
 * Tracks whether the workflow Files <wa-details> is open. Initialized to
 * match the initial session type and updated imperatively from
 * wa-show/wa-hide so user toggles survive across re-renders. Without this,
 * binding `?open=${isWorkflow}` would force the section open on every render
 * pass, defeating user collapses.
 */
export const fileSelectionOpen$ = signal(
  DEFAULT_STATE.sessionType === SESSION_TYPES.WORKFLOW,
);

// ---------------------------------------------------------------------------
// Model / agent catalog data
// ---------------------------------------------------------------------------

export const modelOptions$ = signal<ModelOptionData[]>([]);
export const workflowModelOptions$ = signal<ModelOptionData[] | undefined>(
  undefined,
);
export const toolUseModelOptions$ = signal<ModelOptionData[] | undefined>(
  undefined,
);
export const workflowAgentOptions$ = signal<AgentOptionData[]>([]);
export const toolUseAgentOptions$ = signal<AgentOptionData[]>([]);

// ---------------------------------------------------------------------------
// Chat / voice state
// ---------------------------------------------------------------------------

export const isRecording$ = signal(false);
export const isPolishing$ = signal(false);

// ---------------------------------------------------------------------------
// Banners / onboarding state
// ---------------------------------------------------------------------------

export const apiKeyBanner$ = signal<ApiKeyBannerState>({ visible: false });
export const agentConfigBanner$ = signal<AgentConfigBannerState>({
  visible: false,
});
export const dependencyBanner$ = signal<DependencyBannerState>({
  visible: false,
});
export const gettingStartedVisible$ = signal(false);
// Session-only: the host re-sends SHOW_GETTING_STARTED_BANNER on file
// refreshes, so dismissal is tracked separately and never persisted.
export const gettingStartedDismissed$ = signal(false);
export const sessionHintDismissed$ = signal(true);
export const loginBannerVisible$ = signal(false);
// Onboarding funnel (PRD: agent-native onboarding). The host owns the real
// state; 'pending' only suppresses first-paint launcher/welcome flashes until
// SET_ONBOARDING_FUNNEL arrives.
export const onboardingFunnelState$ =
  signal<WebviewOnboardingFunnelState>('pending');

// ---------------------------------------------------------------------------
// Host-pushed debug flag (mirrored from MainApp's @state field in willUpdate
// so the module-scope sessionContext$ derivation can observe it).
// ---------------------------------------------------------------------------

export const debugMode$ = signal(false);

// ---------------------------------------------------------------------------
// Derived read helpers
// ---------------------------------------------------------------------------

export function getModelOptionsForSession(
  sessionType: SessionType,
): ModelOptionData[] {
  if (sessionType === SESSION_TYPES.WORKFLOW) {
    return workflowModelOptions$.get() ?? modelOptions$.get();
  }
  return toolUseModelOptions$.get() ?? modelOptions$.get();
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
  const agentId = toolUseAgent$.get();
  const opt = toolUseAgentOptions$.get().find((o) => o.value === agentId);
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
  instruction: instruction$.get(),
  placeholder: instructionPlaceholder$.get(),
  workflowAgent: workflowAgent$.get(),
  toolUseAgent: toolUseAgent$.get(),
  model: model$.get(),
  workflowAgentOptions: workflowAgentOptions$.get(),
  toolUseAgentOptions: toolUseAgentOptions$.get(),
  modelOptions: getModelOptionsForSession(sessionType$.get()),
  isRecording: isRecording$.get(),
  isPolishing: isPolishing$.get(),
  debugMode: debugMode$.get(),
  isOrchestratorSelected: isSelectedAgentOrchestrator$.get(),
}));

/**
 * Reset every writable signal to its initial value. Called from `MainApp`'s
 * constructor on remount in the same JS context (tests, hot reload) so each
 * mount starts from the same slate a fresh per-instance field set used to
 * provide. Main-view state is singleton-scoped per the file header, so the
 * reset is a per-mount slate, not multi-instance coordination.
 */
export function resetMainViewState(): void {
  sessionType$.set(DEFAULT_STATE.sessionType);
  workflowAgent$.set(DEFAULT_STATE.workflowAgent);
  toolUseAgent$.set(DEFAULT_STATE.toolUseAgent);
  model$.set(DEFAULT_STATE.model);
  commit$.set(DEFAULT_STATE.commit);
  instruction$.set(DEFAULT_STATE.instruction);
  workflowInstruction$.set(DEFAULT_STATE.workflowInstruction);
  toolUseInstruction$.set(DEFAULT_STATE.toolUseInstruction);
  instructionPlaceholder$.set(
    ONBOARDING_PLACEHOLDERS[DEFAULT_STATE.sessionType][0],
  );
  singleFiles$.set({ ...DEFAULT_SINGLE_FILES });
  fileOptions$.set({ ...DEFAULT_FILE_OPTIONS });
  multiFiles$.set({ ...DEFAULT_MULTI_FILES });
  checkboxValues$.set({ ...DEFAULT_CHECKBOX_VALUES });
  isGitRepo$.set(true);
  latexdiffsVisible$.set(DEFAULT_STATE.latexdiffsVisible);
  fileSelectionOpen$.set(DEFAULT_STATE.sessionType === SESSION_TYPES.WORKFLOW);
  modelOptions$.set([]);
  workflowModelOptions$.set(undefined);
  toolUseModelOptions$.set(undefined);
  workflowAgentOptions$.set([]);
  toolUseAgentOptions$.set([]);
  isRecording$.set(false);
  isPolishing$.set(false);
  apiKeyBanner$.set({ visible: false });
  agentConfigBanner$.set({ visible: false });
  dependencyBanner$.set({ visible: false });
  gettingStartedVisible$.set(false);
  gettingStartedDismissed$.set(false);
  sessionHintDismissed$.set(true);
  loginBannerVisible$.set(false);
  onboardingFunnelState$.set('pending');
  debugMode$.set(false);
}
