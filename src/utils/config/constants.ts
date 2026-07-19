// Local imports - platform
import { tryGlobalState } from '@platform/platform';
import { GlobalStateKey } from '@shared/state/stateKeys';

// Local imports - common

// Local imports - config utils
import { getConfig } from './configUtils';

// Settings query constants for VS Code settings UI
export const SETTINGS_QUERY = {
  EXTENSION: '@ext:texra-ai.texra',
  MODELS: '@ext:texra-ai.texra models',
} as const;

// Time constants
export const REFRESH_THRESHOLD_MS = 200;
export const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

// Debounce delay constants for UI responsiveness
export const DEBOUNCE_OPTIONS_MS = 300; // Dropdown options refresh

// Tool groups marked `toggleable: true` in EXTERNAL_TOOL_DEFS are treated
// as opt-in: they're disabled for new users on first install, and the Tools
// dashboard shows a toggle so the user can turn them on. Seeding happens in
// `initializeToolDefaults()`; existing profiles are never re-seeded.

/** Determine whether tool-use session persistence is enabled. */
export function getToolUsePersistenceEnabled(): boolean {
  return getConfig<boolean>('texra.toolUse.persistence.enabled', true);
}

/** Set whether the memory tool is enabled for tool-use sessions. */
export async function setToolUseMemoryEnabled(enabled: boolean): Promise<void> {
  await tryGlobalState()?.update(GlobalStateKey.MEMORY_ENABLED, enabled);
}

/** Get the set of tool group IDs disabled by the user. */
export function getDisabledToolIds(): ReadonlySet<string> {
  const raw =
    tryGlobalState()?.get<string[]>(GlobalStateKey.DISABLED_TOOLS, []) ?? [];
  return new Set(raw);
}

/** Toggle a tool group's enabled/disabled state. */
export async function setToolEnabled(
  toolId: string,
  enabled: boolean,
): Promise<void> {
  const current =
    tryGlobalState()?.get<string[]>(GlobalStateKey.DISABLED_TOOLS, []) ?? [];
  const set = new Set(current);
  if (enabled) {
    set.delete(toolId);
  } else {
    set.add(toolId);
  }
  await tryGlobalState()?.update(GlobalStateKey.DISABLED_TOOLS, [...set]);
}
