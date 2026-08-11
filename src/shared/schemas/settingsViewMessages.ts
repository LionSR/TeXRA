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

// Re-export the Goal type from its shared leaf module so this file (consumed by
// webview frontends) does not pull in GoalTool/GoalStore runtime modules. The
// goal helpers are imported from '@shared/schemas/goal' directly.
export { type Goal } from './goal';

// Re-export the types and values needed by settings consumers from the
// individual view-message modules so the historical settings surface (single
// import site) stays intact. Keep this selective: the schemas themselves are
// deliberately not re-exported here.
export { type MemoryViewItem, type MemoryPreview } from './memoryViewMessages';

export {
  HISTORY_RUN_STATUS,
  resolveHistoryRunStatus,
  type HistoryItem,
  type HistoryRunStatus,
  type UpdateHistoryMessage,
} from './historyViewMessages';

export {
  API_ACCESS_MODE_OPTIONS,
  DEFAULT_GLOBAL_STREAMING,
  DEFAULT_QUOTA_AUTO_SWITCHED,
  type ApiAccessMode,
  type NumberSetting,
  type ProviderKeyStatus,
  type ProviderSetting,
  type RemoteAgent,
  type SessionProblem,
  type UpdateProfileMessage,
} from './profileViewMessages';

// Settings-specific data + outbound message schemas and the inbound schemas.
export * from './settingsView/data';
export * from './settingsView/inbound';
