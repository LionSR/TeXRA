/**
 * Module-level reactive state for the Settings view.
 *
 * What the host sends lands in one record ({@link hostState}), one field per
 * page, and in one signal per catalog setting ({@link settingSignal}).
 *
 * SettingsApp has no persistence/restore path: every signal here is written
 * only by `applyOutboundMessage` (see `messageDispatcher.ts`) in response to
 * backend SETTINGS_VIEW_COMMANDS messages — the
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

import type { SettingRow } from '@texra-ai/harness/schemas';
import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';
import type { SettingsHostState } from '@texra/shared/settingsView/settingsViewMessages';
import type {
  SettingsSectionName,
  SettingsTabPanelName,
} from '@texra/shared/settingsView/settingsTarget';
import { createTrackedSignalRegistry } from '@texra/shared/signals';
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
 * the wire field name; it names the row, whose schema types the value. The
 * signals are keyed by the row's key, which is what lets
 * {@link applySettingsSnapshot} apply a whole catalog-derived snapshot
 * without a per-setting `.set()` line, and lets the row renderers
 * (`stateSettingRows.ts`) and tabs read a setting by its row alone, with no
 * per-setting declaration or property passed down to them.
 */
export function settingSignal<A>(row: SettingRow<A>): Signal.State<A> {
  // cast: the signal under the row's key holds values its schema parsed.
  return signalFor(row.key) as Signal.State<A>;
}

/**
 * The signal under a wire key. Throws on a key with no settings-view catalog
 * row: a signal that no snapshot can ever reach would silently render its
 * default forever.
 */
function signalFor(key: string): Signal.State<unknown> {
  let state = CATALOG_SIGNALS.get(key);
  if (!state) {
    const entry = TEXRA_SETTINGS.settingsViewByKey(key);
    if (!entry) {
      throw new Error(`No settings-view catalog row for setting "${key}"`);
    }
    state = trackedSignal<unknown>(() =>
      Schema.decodeUnknownSync(entry.schema)(undefined),
    );
    CATALOG_SIGNALS.set(key, state);
  }
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
    signalFor(key).set(value);
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
// What the host knows for the view
// ---------------------------------------------------------------------------
/** The host's pages as last sent; a page absent here has not arrived yet,
 *  which its tab renders as loading, never as empty. */
export const hostState = trackedSignal<Partial<SettingsHostState>>(() => ({}));

export type PluginsPageData = SettingsHostState['plugins'];

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
// Reset — module-level state is shared across remounts in the same JS context
// (tests, hot reload), so a fresh mount replays every registered default.
// ---------------------------------------------------------------------------
export function resetSettingsState(): void {
  resetTrackedSignals();
}
