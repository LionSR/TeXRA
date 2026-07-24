/**
 * Schema definitions for SettingsView messages.
 *
 * Public entry point. Combines messages from MemoryView, HistoryView, and
 * ProfileView with the settings-specific data, outbound, and inbound schemas
 * into a single unified surface for the settings view. External consumers
 * (webviews, CLI, desktop) import from this module; the schemas themselves
 * live in `./settingsView/data` and `./settingsView/inbound`.
 */

// SETTINGS_VIEW_CMD is defined in commands.ts to avoid a circular dependency;
// re-exported here for consumers that expect it from the schema module.
export { SETTINGS_VIEW_CMD } from '@shared/ipc';

// Re-export Goal metadata from its shared leaf module so this file (consumed by
// webview frontends) does not pull in GoalTool/GoalStore runtime modules.
export {
  formatGoalTime,
  isGoalInFlight,
  goalElapsedMs,
  type Goal,
  type GoalStatus,
} from './goal';

// Re-export types (and one constant) from the individual view-message
// modules so the historical settings surface (single import site) stays
// intact. The schemas themselves are no longer re-exported here — consumers
// only ever needed the inferred types through this barrel.
export { type MemoryViewItem, type MemoryPreview } from './memoryViewMessages';

export { type HistoryItem } from './historyViewMessages';

export {
  type ProviderKeyStatus,
  type ProviderVscodeSetting,
  type NumberVscodeSetting,
} from './profileViewMessages';

// Settings-specific data + outbound message schemas and the inbound schemas.
export * from './settingsView/data';
export * from './settingsView/inbound';
