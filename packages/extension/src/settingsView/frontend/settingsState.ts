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
 * receiver. The one exception is the page shown, which the user's navigation
 * also selects, through the same `selectSettingsPage`.
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

import { Schema } from 'effect';

import type { SubscriptionAuthStatuses } from '@texra/shared/model/subscriptionAuth';
import type { SubscriptionUsageSnapshots } from '@texra/shared/model/subscriptionUsage';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import {
  DEFAULT_LATEX_SETTINGS_STATUS,
  type AgentSelectionItem,
  type ModelSelectionItem,
  type PRSubscriptionEntry,
  type SettingsTeamPreset,
  type SettingsViewOutboundMessage,
} from '@texra/shared/settingsView/settingsViewMessages';
import type { ProviderKeyStatus } from '@texra/shared/settingsView/profileViewMessages';
import type {
  SettingsSectionName,
  SettingsTabPanelName,
} from '@texra/shared/settingsView/settingsTarget';
import { createTrackedSignalRegistry } from '@texra/shared/signals';
import type {
  AgentScanIssue,
  MemoryViewItem,
  SkillDisplayIssue,
  SkillDisplayItem,
} from '@texra-ai/harness/schemas';
import type { Signal } from '@lit-labs/signals';

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
 * The row already owns the default (decoding `undefined` yields its
 * `withDecodingDefault` value), so a caller restates neither the default nor
 * the wire field name; it names the key and the value type it renders. Being
 * keyed is what lets {@link applySettingsSnapshot} apply a whole
 * catalog-derived snapshot without a per-setting `.set()` line, and lets the
 * row renderers (`stateSettingRows.ts`) and tabs read a setting by key alone,
 * with no per-setting declaration or property passed down to them.
 *
 * Throws on a key with no settings-view catalog row: a signal that no snapshot
 * can ever reach would silently render its default forever.
 */
export function settingSignal<T>(key: string): Signal.State<T> {
  const existing = CATALOG_SIGNALS.get(key);
  if (existing) return existing as Signal.State<T>;
  const entry = TEXRA_SETTINGS.settingsViewByKey(key);
  if (!entry) {
    throw new Error(`No settings-view catalog row for setting "${key}"`);
  }
  const state = trackedSignal<T>(
    // cast: the catalog row types its own default; the caller names T for it.
    () => Schema.decodeUnknownSync(entry.schema)(undefined) as T,
  );
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
 * General, where application preferences live. Model setup links target
 * Models explicitly.
 */
export const selectedPanel = trackedSignal<SettingsTabPanelName>(
  () => 'general',
);

/**
 * The sub-tab last shown on each page, kept while the view lives so returning
 * to a page lands where the user left it. A page with no entry shows its
 * first section.
 */
export const selectedSections = trackedSignal<{
  readonly [P in SettingsTabPanelName]?: SettingsSectionName<P>;
}>(() => ({}));

/** Show a page, on `section` when one is named, else where it was left.
 *  The host's tab push and the user's click both land here. */
export function selectSettingsPage(
  page: SettingsTabPanelName,
  section?: SettingsSectionName,
): void {
  selectedPanel.set(page);
  if (section)
    selectedSections.set({ ...selectedSections.get(), [page]: section });
}

// ---------------------------------------------------------------------------
// Memory state
// ---------------------------------------------------------------------------
export const memoryItems = trackedSignal<readonly MemoryViewItem[]>(() => []);

// ---------------------------------------------------------------------------
// Profile state
// ---------------------------------------------------------------------------
/** Null until the host's first profile message: an unknown key state, never
 *  rendered as "not set". */
export const providerKeyStatuses = trackedSignal<
  readonly ProviderKeyStatus[] | null
>(() => null);
// ---------------------------------------------------------------------------
// Model selection state
// ---------------------------------------------------------------------------
export const modelSelectionItems = trackedSignal<readonly ModelSelectionItem[]>(
  () => [],
);

// ---------------------------------------------------------------------------
// Agent selection state
// ---------------------------------------------------------------------------
export const agentSelectionItems = trackedSignal<readonly AgentSelectionItem[]>(
  () => [],
);
export const customAgentDir = trackedSignal(() => '');
export const customAgentDirIsDefault = trackedSignal(() => true);
export const customAgentScanIssues = trackedSignal<readonly AgentScanIssue[]>(
  () => [],
);

// ---------------------------------------------------------------------------
// Agent teams state
// ---------------------------------------------------------------------------
export const teamPresets = trackedSignal<readonly SettingsTeamPreset[]>(
  () => [],
);
export const orchestratorAgents = trackedSignal<readonly string[]>(() => []);
/** Team the workspace agents resolve to; null when they run no team. */
export const activePresetId = trackedSignal<string | null>(() => null);

/**
 * Each catalog snapshot's acknowledgement generation, keyed by snapshot name
 * and bumped on every snapshot message of that kind, including a rebroadcast
 * that carries the same values after a rejected or failed write, so a number
 * row on that snapshot repaints the acknowledged value over the edit
 * (`ackGeneration`).
 */
export const settingsSnapshotRevisions = trackedSignal<
  Readonly<Partial<Record<string, number>>>
>(() => ({}));

// ---------------------------------------------------------------------------
// Skills state
// ---------------------------------------------------------------------------
export const skillsList = trackedSignal<readonly SkillDisplayItem[]>(() => []);
export const skillLoadIssues = trackedSignal<readonly SkillDisplayIssue[]>(
  () => [],
);

// ---------------------------------------------------------------------------
// Plugins page state: null until the first rows arrive
// ---------------------------------------------------------------------------
export type PluginsPageData = Omit<
  Extract<SettingsViewOutboundMessage, { command: 'updatePlugins' }>,
  'command'
>;
export const pluginsPage = trackedSignal<PluginsPageData | null>(() => null);

// ---------------------------------------------------------------------------
// Git author settings state
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Reset — module-level state is shared across remounts in the same JS context
// (tests, hot reload), so a fresh mount replays every registered default.
// ---------------------------------------------------------------------------
export function resetSettingsState(): void {
  resetTrackedSignals();
}
