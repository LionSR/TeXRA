// Local imports
import type { StateStore } from '@platform/interfaces';
import { tryGlobalState } from '@platform/platform';
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
 * Renamed tool group IDs, keyed by the ID that may still sit in a persisted
 * `DISABLED_TOOLS` array. Reads map the old ID onto the current one so a
 * rename can't silently re-enable a group that seeding — or the user — had
 * switched off; profiles are never re-seeded, so the stale entry is the only
 * record of that choice. `setToolEnabled` writes the mapped set back, so a
 * profile migrates the first time any tool is toggled.
 */
const RENAMED_TOOL_IDS: ReadonlyMap<string, string> = new Map([
  ['workflow-script', 'multi-agent-workflow'],
]);

/**
 * Get the set of tool group IDs disabled by the user.
 *
 * Omitting `store` reads the ambient platform global state; hosts that own an
 * explicit global-state port (the desktop settings controllers) pass it so the
 * read and the matching write hit the same store.
 *
 * The parameter deliberately excludes `null`: a default parameter fires only
 * on `undefined`, so allowing both spellings of "absent" would make
 * `f(id, on, undefined)` write to the ambient store while `f(id, on, null)`
 * silently dropped the write.
 */
export function getDisabledToolIds(store?: StateStore): ReadonlySet<string> {
  const resolved = store ?? tryGlobalState();
  const raw = resolved?.get<string[]>(GlobalStateKey.DISABLED_TOOLS, []) ?? [];
  return new Set(raw.map((id) => RENAMED_TOOL_IDS.get(id) ?? id));
}

/** Toggle a tool group's enabled/disabled state. */
export async function setToolEnabled(
  toolId: string,
  enabled: boolean,
  store?: StateStore,
): Promise<void> {
  const resolved = store ?? tryGlobalState();
  const set = new Set(getDisabledToolIds(resolved ?? undefined));
  if (enabled) {
    set.delete(toolId);
  } else {
    set.add(toolId);
  }
  await resolved?.update(GlobalStateKey.DISABLED_TOOLS, [...set]);
}
