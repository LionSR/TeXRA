// Local imports
import type { StateStore } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';

// Time constants
export const REFRESH_THRESHOLD_MS = 200;
export const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

// Debounce delay constants for UI responsiveness
export const DEBOUNCE_OPTIONS_MS = 300; // Dropdown options refresh

// Tool groups marked `toggleable: true` in EXTERNAL_TOOL_DEFS are treated
// as opt-in: they're disabled for new users on first install, and the Tools
// dashboard shows a toggle so the user can turn them on. Seeding happens in
// `seedDisabledToolDefaults()` during host startup; existing profiles are
// never re-seeded.

/**
 * Get the set of tool group IDs disabled by the user.
 *
 * `store` is the process global state the caller holds (the `AppState`
 * service, or the store a host root threaded down), so the read and the
 * matching write hit the same store.
 */
export function getDisabledToolIds(store: StateStore): ReadonlySet<string> {
  const raw = store.get<string[]>(GlobalStateKey.DISABLED_TOOLS, []);
  return new Set(raw);
}

/** Toggle a tool group's enabled/disabled state. */
export async function setToolEnabled(
  toolId: string,
  enabled: boolean,
  store: StateStore,
): Promise<void> {
  const set = new Set(getDisabledToolIds(store));
  if (enabled) {
    set.delete(toolId);
  } else {
    set.add(toolId);
  }
  await store.update(GlobalStateKey.DISABLED_TOOLS, [...set]);
}
