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

// Re-export the canonical LaTeX config field type so existing consumers that
// import `LatexConfigField` from this module continue to compile.
export type { LatexConfigField } from '@shared/constants/latex';

// Re-export Goal metadata from its shared leaf module so this file (consumed by
// webview frontends) does not pull in GoalTool/GoalStore runtime modules.
export {
  GoalSchema,
  formatGoalTime,
  isGoalInFlight,
  goalDurationMs,
  goalElapsedMs,
  type Goal,
  type GoalStatus,
} from './goal';

// Re-export data schemas from the individual view-message modules so the
// historical settings surface (single import site) stays intact.
export {
  MemoryViewItemSchema,
  MemoryPreviewSchema,
  type MemoryViewItem,
  type MemoryPreview,
  type MemoryItemActionDetail,
  type MemoryPathMessage,
  type MemoryDeleteMessage,
  type MemoryEnabledMessage,
} from './memoryViewMessages';

export {
  HistoryItemSchema,
  type HistoryItem,
  type HistoryIdMessage,
} from './historyViewMessages';

export {
  API_ACCESS_MODE_OPTIONS,
  NumberVscodeSettingSchema,
  type RemoteAgent,
  type ApiAccessMode,
  type ProviderKeyStatus,
  type ProviderVscodeSetting,
  type NumberVscodeSetting,
} from './profileViewMessages';

// Settings-specific data + outbound message schemas and the inbound schemas.
export * from './settingsView/data';
export * from './settingsView/inbound';
